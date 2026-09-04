import { inngest } from '@/lib/jobs/client';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import { getLearnerProfile } from '@/lib/db/queries/learner-profile';
import { getExerciseById, getExerciseAnswerKeyForScoring } from '@/lib/db/queries/exercises';
import { getSubmission, updateSubmissionStatus } from '@/lib/db/queries/submissions';
import {
  logAttemptsAndClassifyRectifications,
  recomputeMasteryAndModuleProgress,
  generateNextExercise,
  describeRectification,
} from '@/lib/jobs/advance-learner';
import { parseDayBookXml, DayBookParseError } from '@/lib/parsing/daybook';
import { parseTrialBalanceXml, TrialBalanceParseError } from '@/lib/parsing/trialbalance';
import { runValidityGate, type ValidityError } from '@/lib/tutor/submission-gate';
import { scoreSubmission, collectErrorCodes } from '@/lib/tutor/score-submission';
import { adjudicateScoringResult } from '@/lib/tutor/adjudicate-findings';
import { generateCoaching } from '@/lib/tutor/generate-coaching';
import { insertScoringResult } from '@/lib/db/queries/scoring-results';
import { recordSubmissionScore } from '@/lib/llm/tracing';

// Triggered by the submitFiles Server Action (lib/db/queries/submissions.ts's
// insertSubmission having already created the row with status: 'validating').
// Each step is independently retried by Inngest on failure without re-running
// completed steps — see architecture.md Section 5. No business logic is
// reimplemented here: parsing, the gate, scoring, and coaching are all
// imported from Units 05/06 as-is.
export const runScoring = inngest.createFunction(
  { id: 'run-scoring', triggers: [{ event: 'submission/uploaded' }] },
  async ({ event, step }) => {
    const submissionId: string = event.data.submissionId;

    const supabase = createServiceRoleClient();

    const { submission, exercise, profile } = await step.run('fetch-submission-and-exercise', async () => {
      const submission = await getSubmission(supabase, submissionId);
      if (!submission) {
        throw new Error(`Submission ${submissionId} not found.`);
      }

      const exercise = await getExerciseById(supabase, submission.exercise_id);
      if (!exercise) {
        throw new Error(`Exercise ${submission.exercise_id} not found.`);
      }

      const profile = await getLearnerProfile(supabase, submission.learner_id);
      if (!profile) {
        throw new Error(`Learner profile ${submission.learner_id} not found.`);
      }

      return { submission, exercise, profile };
    });

    const parsed = await step.run('parse-xml-files', async () => {
      // This job only ever runs for the original two-file exercise path
      // (submitFiles always populates both paths before sending
      // submission/uploaded — see that file's routing comment), so a null
      // here means the submission row is malformed, not a normal case to
      // handle gracefully.
      if (!submission.daybook_path || !submission.trialbalance_path) {
        throw new Error(`Submission ${submissionId} is missing a file path.`);
      }

      const [daybookDownload, trialbalanceDownload] = await Promise.all([
        supabase.storage.from('submissions').download(submission.daybook_path),
        supabase.storage.from('submissions').download(submission.trialbalance_path),
      ]);

      if (daybookDownload.error || !daybookDownload.data) {
        return { status: 'invalid' as const, errors: [{ code: 'parse_failed', message: 'The Day Book file could not be read.' }] };
      }
      if (trialbalanceDownload.error || !trialbalanceDownload.data) {
        return { status: 'invalid' as const, errors: [{ code: 'parse_failed', message: 'The Trial Balance file could not be read.' }] };
      }

      const daybookBuffer = Buffer.from(await daybookDownload.data.arrayBuffer());
      const trialbalanceBuffer = Buffer.from(await trialbalanceDownload.data.arrayBuffer());

      try {
        const dayBook = parseDayBookXml(daybookBuffer);
        const trialBalance = parseTrialBalanceXml(trialbalanceBuffer);
        return { status: 'parsed' as const, dayBook, trialBalance };
      } catch (error) {
        const message =
          error instanceof DayBookParseError || error instanceof TrialBalanceParseError
            ? error.message
            : 'One of the files could not be read.';
        return { status: 'invalid' as const, errors: [{ code: 'parse_failed', message }] };
      }
    });

    if (parsed.status === 'invalid') {
      await step.run('mark-invalid-parse-failure', async () => {
        await updateSubmissionStatus(supabase, submissionId, 'invalid', parsed.errors as ValidityError[]);
      });
      return { status: 'invalid', submissionId };
    }

    const gateResult = await step.run('run-validity-gate', async () => {
      return runValidityGate(parsed.dayBook, parsed.trialBalance, exercise, profile.books_begin_date);
    });

    if (gateResult.status === 'invalid') {
      await step.run('mark-invalid-gate-failure', async () => {
        await updateSubmissionStatus(supabase, submissionId, 'invalid', gateResult.errors);
      });
      return { status: 'invalid', submissionId };
    }

    await step.run('mark-scoring', async () => {
      await updateSubmissionStatus(supabase, submissionId, 'scoring', null);
    });

    const engineResult = await step.run('score-submission', async () => {
      const answerKey = await getExerciseAnswerKeyForScoring(supabase, exercise.id, submission.learner_id);
      if (!answerKey) {
        throw new Error(`Answer key for exercise ${exercise.id} not found.`);
      }
      return scoreSubmission(parsed.dayBook, parsed.trialBalance, answerKey);
    });

    // Hybrid scoring (2026-08-20): the engine's findings are adjudicated by
    // the LLM judge — dismissed findings (acceptable practice variations)
    // flip to correct and the result is rebuilt. Fail-safe: on any
    // adjudication failure the engine's verdicts stand unchanged, so this
    // step can only relax, never invent findings.
    const scoringResult = await step.run('adjudicate-findings', async () => {
      const answerKey = await getExerciseAnswerKeyForScoring(supabase, exercise.id, submission.learner_id);
      if (!answerKey) {
        return engineResult;
      }
      return adjudicateScoringResult(submission.learner_id, parsed.dayBook, answerKey, engineResult);
    });

    // Concept attempts are logged (append-only, Unit 09) before coaching runs
    // so rectification.ts (Unit 12) can classify this exercise's just-logged
    // attempts against their immediately-prior history — coaching needs that
    // classification as input, so this step must precede generate-coaching,
    // ahead of where Unit 09 originally placed the equivalent logging.
    const rectifications = await step.run('log-attempts-and-classify-rectification', async () => {
      return logAttemptsAndClassifyRectifications(supabase, submission.learner_id, exercise.id, scoringResult);
    });

    const feedback = await step.run('generate-coaching', async () => {
      const answerKey = await getExerciseAnswerKeyForScoring(supabase, exercise.id, submission.learner_id);
      return generateCoaching(submission.learner_id, {
        overallResult: scoringResult.overall_result,
        scoringResult,
        qualitative: null,
        answerKey,
        rectificationDescriptions: rectifications.map(describeRectification),
      });
    });

    await step.run('persist-scoring-result', async () => {
      const errorCodes = collectErrorCodes(scoringResult);
      await insertScoringResult(supabase, {
        submissionId,
        exerciseId: exercise.id,
        learnerId: submission.learner_id,
        scoringResult,
        errorCodes,
        qualitativeScore: null,
        overallResult: scoringResult.overall_result,
        feedback,
      });
      // 'scored' flips HERE, as soon as the feedback exists — the client
      // shows it immediately and then POLLS for the next exercise
      // (PendingSubmission.tsx), which is still generating below (batch +
      // source-document PDFs add 60s+; holding the feedback hostage to them
      // was the 3-minute wait observed live 2026-08-21).
      await updateSubmissionStatus(supabase, submissionId, 'scored', null);

      // Langfuse evals (2026-09-01): each scored submission becomes a set of
      // scores on a per-submission trace, so cost/model changes can be
      // correlated with learner outcomes. Fire-and-forget.
      recordSubmissionScore({
        learnerId: submission.learner_id,
        submissionId,
        weightedScore: scoringResult.weighted_score,
        overallResult: scoringResult.overall_result,
        tbTieOut: scoringResult.tb_tie_out,
      });
    });

    // Mastery + module-progress recompute (Unit 09 mastery, Unit 12 module
    // advancement): re-derives concept_mastery from the full concept_attempts
    // history (already logged above) via mastery.ts, then evaluates module
    // advancement on top of the freshly-applied mastery state via
    // module-progress.ts — both are the one sanctioned write path for their
    // respective tables, never written any other way (architecture.md
    // invariant 5).
    await step.run('recompute-mastery-and-module-progress', async () => {
      await recomputeMasteryAndModuleProgress(supabase, submission.learner_id);
    });

    // Next-exercise generation (Unit 09): triggers automatically once
    // feedback is delivered, same auto-delivery pattern as the diagnostic in
    // Unit 04 — the learner doesn't have to ask. Targets whatever the
    // learner is now actually weakest at, factoring in the reinforcement/
    // escalation state the recompute step above just wrote.
    await step.run('generate-next-exercise', async () => {
      await generateNextExercise(supabase, {
        learnerId: submission.learner_id,
        previousDifficultyLevel: exercise.difficulty_level,
        licenseMode: profile.license_mode,
        afterIso: submission.created_at,
      });
    });

    return { status: 'scored', submissionId };
  },
);


