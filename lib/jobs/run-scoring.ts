import { inngest } from '@/lib/jobs/client';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import { getLearnerProfile } from '@/lib/db/queries/learner-profile';
import { getExerciseById, getExerciseAnswerKey, countExercisesForLearner } from '@/lib/db/queries/exercises';
import { getSubmission, updateSubmissionStatus } from '@/lib/db/queries/submissions';
import { parseDayBookXml, DayBookParseError } from '@/lib/parsing/daybook';
import { parseTrialBalanceXml, TrialBalanceParseError } from '@/lib/parsing/trialbalance';
import { runValidityGate, type ValidityError } from '@/lib/tutor/submission-gate';
import { scoreSubmission, collectErrorCodes } from '@/lib/tutor/score-submission';
import { adjudicateScoringResult } from '@/lib/tutor/adjudicate-findings';
import { generateCoaching } from '@/lib/tutor/generate-coaching';
import { insertScoringResult } from '@/lib/db/queries/scoring-results';
import { getHintDepthForExercise } from '@/lib/db/queries/hint-requests';
import { insertConceptAttempts, getConceptAttempts, getConceptMasteryMap, applyStatePatch } from '@/lib/db/queries/mastery';
import { recomputeMastery, selectWeakConcept } from '@/lib/tutor/mastery';
import { generateAdaptiveExercise } from '@/lib/tutor/generate-exercise';
import { generateReviewExercise } from '@/lib/tutor/generate-review-exercise';
import { selectNextExerciseKind } from '@/lib/tutor/select-exercise-kind';
import { selectBatchConcepts } from '@/lib/tutor/select-batch-concepts';
import { getRecentCompanyTransactionLog } from '@/lib/db/queries/company';
import { CONCEPT_TAGS, EXERCISE_DIFFICULTY_LEVELS, type ExerciseDifficultyLevel } from '@/lib/schemas/exercise';
import { getModuleProgress, upsertModuleProgress } from '@/lib/db/queries/module-progress';
import { deriveNextModuleProgress } from '@/lib/tutor/module-progress';
import { classifyRectificationsForExercise, type RectificationResult } from '@/lib/tutor/rectification';

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
      const answerKey = await getExerciseAnswerKey(supabase, exercise.id);
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
      const answerKey = await getExerciseAnswerKey(supabase, exercise.id);
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
      const hintRungsUsed = await getHintDepthForExercise(supabase, submission.learner_id, exercise.id);

      const attemptsThisExercise = scoringResult.concept_results.map((conceptResult) => ({
        conceptTag: conceptResult.concept_tag,
        result: conceptResult.result,
        hintRungsUsed,
      }));
      await insertConceptAttempts(supabase, submission.learner_id, exercise.id, attemptsThisExercise);

      const allAttempts = await getConceptAttempts(supabase, submission.learner_id);
      const conceptTagsThisExercise = scoringResult.concept_results.map((result) => result.concept_tag);
      return classifyRectificationsForExercise(conceptTagsThisExercise, allAttempts);
    });

    const feedback = await step.run('generate-coaching', async () => {
      const answerKey = await getExerciseAnswerKey(supabase, exercise.id);
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
    });

    // Mastery + module-progress recompute (Unit 09 mastery, Unit 12 module
    // advancement): re-derives concept_mastery from the full concept_attempts
    // history (already logged above) via mastery.ts, then evaluates module
    // advancement on top of the freshly-applied mastery state via
    // module-progress.ts — both are the one sanctioned write path for their
    // respective tables, never written any other way (architecture.md
    // invariant 5).
    await step.run('recompute-mastery-and-module-progress', async () => {
      const [allAttempts, currentMastery] = await Promise.all([
        getConceptAttempts(supabase, submission.learner_id),
        getConceptMasteryMap(supabase, submission.learner_id),
      ]);

      const patch = recomputeMastery({ attempts: allAttempts, currentMastery });
      await applyStatePatch(supabase, submission.learner_id, patch);

      const updatedMastery = await getConceptMasteryMap(supabase, submission.learner_id);
      const currentModuleProgress = await getModuleProgress(supabase, submission.learner_id);
      const nextModuleProgress = deriveNextModuleProgress(currentModuleProgress, updatedMastery);
      await upsertModuleProgress(supabase, submission.learner_id, nextModuleProgress);
    });

    // Next-exercise generation (Unit 09): triggers automatically once
    // feedback is delivered, same auto-delivery pattern as the diagnostic in
    // Unit 04 — the learner doesn't have to ask. Targets whatever the
    // learner is now actually weakest at, factoring in the reinforcement/
    // escalation state the recompute step above just wrote.
    await step.run('generate-next-exercise', async () => {
      const [allAttempts, currentMastery] = await Promise.all([
        getConceptAttempts(supabase, submission.learner_id),
        getConceptMasteryMap(supabase, submission.learner_id),
      ]);

      const target = selectWeakConcept(CONCEPT_TAGS, allAttempts, currentMastery);
      if (!target) {
        // Every concept mastered — no further adaptive exercise to generate.
        // Unit 13/14 own what happens next (AIA transition, capstone).
        return;
      }

      const baseDifficultyLevel = deriveBaseDifficultyLevel(exercise.difficulty_level);

      // Unit 14R wiring: place explain/review batches in the cadence (see
      // select-exercise-kind.ts's documented assumption). A review that
      // cannot be built (no anomaly templates seeded yet, sparse company
      // log) falls back to a plain adaptive batch rather than failing the
      // job — the learner always gets SOMETHING next.
      const [priorExerciseCount, recentLog] = await Promise.all([
        countExercisesForLearner(supabase, submission.learner_id),
        getRecentCompanyTransactionLog(supabase, submission.learner_id),
      ]);
      const nextKind = selectNextExerciseKind({
        priorExerciseCount,
        companyTransactionLogCount: recentLog.length,
      });

      if (nextKind === 'review') {
        try {
          await generateReviewExercise(supabase, submission.learner_id, baseDifficultyLevel);
          return;
        } catch {
          // Fall through to a normal adaptive batch below.
        }
      }
      // Phase 2 (spec 14): the 50/50 batch plan — step-up concepts and
      // reinforcement concepts, computed from the same state the target
      // selection used.
      const batchPlan = selectBatchConcepts(target, allAttempts, currentMastery);
      // Phase 1: the batch intro names what the learner is strong at.
      const recentStrengthDescriptions = batchPlan.strengths.map((tag) => tag.replace(/_/g, ' '));
      // Month-per-batch (2026-09-01): the company's timeline advances one
      // calendar month per exercise, anchored on the diagnostic pack's April
      // 2026 — priorExerciseCount includes the diagnostic, so the first
      // adaptive batch (count 1) lands in May, the next in June, and so on.
      // Anchored to exercise count, not mastered-concept count, so the month
      // always moves forward exactly once per batch regardless of how fast
      // concepts are mastered.
      await generateAdaptiveExercise(
        supabase,
        submission.learner_id,
        target,
        baseDifficultyLevel,
        nextKind === 'explain' ? 'explain' : 'adaptive',
        recentStrengthDescriptions,
        batchPlan,
        profile.license_mode,
        priorExerciseCount + 1,
      );
    });

    return { status: 'scored', submissionId };
  },
);

// The next exercise's starting difficulty before any reinforcement drop is
// applied: one level up from whatever exercise was just scored, capped at
// the highest defined level. generateAdaptiveExercise then drops it back
// down a level if reinforcement is active for the target concept.
function deriveBaseDifficultyLevel(previousLevel: ExerciseDifficultyLevel): ExerciseDifficultyLevel {
  const index = EXERCISE_DIFFICULTY_LEVELS.indexOf(previousLevel);
  const nextIndex = Math.min(index + 1, EXERCISE_DIFFICULTY_LEVELS.length - 1);
  return EXERCISE_DIFFICULTY_LEVELS[nextIndex];
}

// Plain-language phrasing of a rectification classification, handed to the
// coaching prompt as a fact to weave into prose (never a raw enum value) —
// concept_tag is only ever surfaced as its own snake_case string today (no
// human-readable label table exists for CONCEPT_TAGS elsewhere), so this
// reads it plainly rather than inventing a labeling scheme this unit's spec
// doesn't ask for.
function describeRectification(result: RectificationResult): string {
  const conceptLabel = result.conceptTag.replace(/_/g, ' ');
  if (result.classification === 'FIXED') {
    return `${conceptLabel} was failing before and is now fixed`;
  }
  return `${conceptLabel} failed again, same as last time: still failing`;
}
