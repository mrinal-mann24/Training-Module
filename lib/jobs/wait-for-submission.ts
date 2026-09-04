import { inngest } from '@/lib/jobs/client';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import { getExerciseById, getExerciseAnswerKeyForScoring } from '@/lib/db/queries/exercises';
import { getSubmission, updateSubmissionStatus } from '@/lib/db/queries/submissions';
import { getSubmissionParts, missingParts, type SubmissionPart } from '@/lib/db/queries/submission-parts';
import { getLedgerReviewItemsForExercise } from '@/lib/db/queries/ledger-review-items';
import { getLearnerProfile } from '@/lib/db/queries/learner-profile';
import { parseDayBookXml, DayBookParseError } from '@/lib/parsing/daybook';
import { parseTrialBalanceXml, TrialBalanceParseError } from '@/lib/parsing/trialbalance';
import { runValidityGate, type ValidityError } from '@/lib/tutor/submission-gate';
import { adjudicateScoringResult } from '@/lib/tutor/adjudicate-findings';
import { scoreSubmission, collectErrorCodes } from '@/lib/tutor/score-submission';
import { scoreQualitative, groundingFromAnswerKey, combineOverallResult } from '@/lib/tutor/score-qualitative';
import { generateCoaching } from '@/lib/tutor/generate-coaching';
import { insertScoringResult } from '@/lib/db/queries/scoring-results';
import { recordSubmissionScore } from '@/lib/llm/tracing';
import {
  logAttemptsAndClassifyRectifications,
  recomputeMasteryAndModuleProgress,
  generateNextExercise,
  describeRectification,
} from '@/lib/jobs/advance-learner';
import type { SubmissionPartType } from '@/lib/schemas/exercise';
import type { ScoringResult } from '@/lib/schemas/scoring';
import type { QualitativeScoring } from '@/lib/schemas/qualitative-scoring';

// Multi-part submissions wait up to this long for the remaining required
// parts before scoring proceeds with whatever arrived, per the spec's
// "30-45 minutes" window. Missing parts are flagged in feedback, never
// silently unscored forever.
const WAIT_WINDOW = '45m';

function extractText(content: unknown): string {
  return (content as { text?: string }).text ?? '';
}

function extractStoragePath(content: unknown): string | null {
  return (content as { storage_path?: string }).storage_path ?? null;
}

// Triggered by submission/part-received for exercises with more than one
// required part (submitFiles/submitTextPart in app/(chat)/chat/actions.ts
// decide which event to send based on exercise.requiredParts.length — see
// that file's comment). submission/part-received fires once per part
// arrival, but only the first arrival for a given submission should start a
// NEW run of this function — later arrivals for the same submission must
// instead be seen by the already-running instance's step.waitForEvent calls
// below, not spawn a second concurrent run. singleton mode: 'skip' keyed on
// submissionId guarantees exactly that: while a run for this submission is
// active (including while parked in waitForEvent), any further trigger for
// the same submissionId is skipped as a new run, but the event itself still
// reaches the active run's waitForEvent matchers.
export const waitForSubmission = inngest.createFunction(
  {
    id: 'wait-for-submission',
    triggers: [{ event: 'submission/part-received' }],
    singleton: { key: 'event.data.submissionId', mode: 'skip' },
  },
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

    // Waits for each currently-missing required part in turn. Checking
    // getSubmissionParts fresh before each waitForEvent call (rather than
    // once up front) covers the "parts arrived out of order, some already
    // in before this job even started" case — step.waitForEvent only
    // catches events sent after it runs, so a part that arrived earlier
    // must be detected by the DB check, not by waiting for its event again.
    for (const partType of exercise.requiredParts) {
      const currentParts = await step.run(`check-part-${partType}`, async () => {
        return getSubmissionParts(supabase, submissionId);
      });

      if (currentParts.some((part) => part.part_type === partType)) {
        continue;
      }

      await step.waitForEvent(`wait-for-${partType}`, {
        event: 'submission/part-received',
        timeout: WAIT_WINDOW,
        if: `async.data.submissionId == "${submissionId}" && async.data.partType == "${partType}"`,
      });
      // Return value intentionally unused — whether it matched or timed
      // out, the next loop iteration (or the completeness check after the
      // loop) re-reads submission_parts as the source of truth, so a
      // same-event-different-part race can never be misread as "this part
      // arrived."
    }

    const finalParts = await step.run('fetch-final-parts', async () => {
      return getSubmissionParts(supabase, submissionId);
    });

    // Per spec: proceeds to scoring with whatever arrived once the wait loop
    // above exits (every required part is in, or the window expired on the
    // last missing one) — never silently blocks forever. stillMissing is
    // threaded into the coaching feedback below rather than treated as a
    // hard failure (that's reserved for genuine submission defects: a
    // parse/gate failure on the file parts that did arrive).
    const stillMissing = missingParts(finalParts, exercise.requiredParts);

    const filePartsPresent = finalParts.filter(
      (part): part is SubmissionPart & { part_type: 'daybook_xml' | 'trialbalance_xml' } =>
        part.part_type === 'daybook_xml' || part.part_type === 'trialbalance_xml',
    );
    const hasBothFileParts = filePartsPresent.length === 2;

    let scoringResult: ScoringResult | null = null;
    let gateErrors: ValidityError[] | null = null;

    if (hasBothFileParts) {
      const parsed = await step.run('parse-xml-files', async () => {
        const daybookPart = finalParts.find((part) => part.part_type === 'daybook_xml');
        const trialbalancePart = finalParts.find((part) => part.part_type === 'trialbalance_xml');
        const daybookPath = daybookPart ? extractStoragePath(daybookPart.content) : null;
        const trialbalancePath = trialbalancePart ? extractStoragePath(trialbalancePart.content) : null;

        if (!daybookPath || !trialbalancePath) {
          return { status: 'invalid' as const, errors: [{ code: 'parse_failed', message: 'A submitted file part is missing its storage reference.' }] };
        }

        const [daybookDownload, trialbalanceDownload] = await Promise.all([
          supabase.storage.from('submissions').download(daybookPath),
          supabase.storage.from('submissions').download(trialbalancePath),
        ]);

        if (daybookDownload.error || !daybookDownload.data || trialbalanceDownload.error || !trialbalanceDownload.data) {
          return { status: 'invalid' as const, errors: [{ code: 'parse_failed', message: 'One of the submitted files could not be read.' }] };
        }

        try {
          const dayBook = parseDayBookXml(Buffer.from(await daybookDownload.data.arrayBuffer()));
          const trialBalance = parseTrialBalanceXml(Buffer.from(await trialbalanceDownload.data.arrayBuffer()));
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
        gateErrors = parsed.errors as ValidityError[];
      } else {
        const gateResult = await step.run('run-validity-gate', async () => {
          return runValidityGate(parsed.dayBook, parsed.trialBalance, exercise, profile.books_begin_date);
        });

        if (gateResult.status === 'invalid') {
          gateErrors = gateResult.errors;
        } else {
          scoringResult = await step.run('score-submission', async () => {
            const answerKey = await getExerciseAnswerKeyForScoring(supabase, exercise.id, submission.learner_id);
            if (!answerKey) {
              throw new Error(`Answer key for exercise ${exercise.id} not found.`);
            }
            const engineResult = scoreSubmission(parsed.dayBook, parsed.trialBalance, answerKey);
            // Hybrid scoring (2026-08-20): same engine-finds/LLM-judges pass
            // as run-scoring.ts — fail-safe to the engine's verdicts.
            return adjudicateScoringResult(submission.learner_id, parsed.dayBook, answerKey, engineResult);
          });
        }
      }
    }

    // A gate failure on the file parts is a genuine submission defect
    // (wrong format/incomplete/unreadable), distinct from "the explain/review
    // text part never arrived" — the spec's invariant that a submission is
    // never scored until it passes the validity gate still holds for
    // whichever file parts this exercise actually requires.
    if (gateErrors) {
      await step.run('mark-invalid', async () => {
        await updateSubmissionStatus(supabase, submissionId, 'invalid', gateErrors as ValidityError[]);
      });
      return { status: 'invalid', submissionId };
    }

    await step.run('mark-scoring', async () => {
      await updateSubmissionStatus(supabase, submissionId, 'scoring', null);
    });

    const textPart = finalParts.find((part) => part.part_type === 'explain_text' || part.part_type === 'review_text');

    let qualitativeScore: QualitativeScoring | null = null;

    if (textPart) {
      qualitativeScore = await step.run('score-qualitative', async () => {
        if (textPart.part_type === 'explain_text') {
          const answerKey = await getExerciseAnswerKeyForScoring(supabase, exercise.id, submission.learner_id);
          if (!answerKey) {
            throw new Error(`Answer key for exercise ${exercise.id} not found.`);
          }
          return scoreQualitative(submission.learner_id, {
            learnerText: extractText(textPart.content),
            groundingItems: groundingFromAnswerKey(answerKey),
            traceName: 'explain-qualitative-scoring',
          });
        }

        const reviewItems = await getLedgerReviewItemsForExercise(supabase, exercise.id);
        return scoreQualitative(submission.learner_id, {
          learnerText: extractText(textPart.content),
          groundingItems: reviewItems.map((item) => ({
            label: item.presented_text,
            detail: item.is_anomaly ? 'this is a genuine anomaly' : 'this entry is actually correct',
          })),
          traceName: 'review-qualitative-scoring',
        });
      });
    }

    if (!scoringResult && !qualitativeScore) {
      // Neither a Tally posting nor a text part ever arrived — nothing to
      // score. Flag as invalid rather than fabricating a result; this is
      // the fully-empty-window-expiry edge case.
      await step.run('mark-invalid-nothing-to-score', async () => {
        await updateSubmissionStatus(supabase, submissionId, 'invalid', [
          { code: 'no_parts_received', message: 'No submission parts were received before the review window closed. Please resubmit.' },
        ]);
      });
      return { status: 'invalid', submissionId };
    }

    const overallResult = combineOverallResult(scoringResult?.overall_result ?? null, qualitativeScore);

    // Concept attempts are logged before coaching so rectification can
    // classify this exercise against its prior history (same order as
    // run-scoring.ts). Only the Tally posting carries concept results; a
    // text-only submission logs nothing.
    const scoredResult = scoringResult;
    const rectifications = scoredResult
      ? await step.run('log-attempts-and-classify-rectification', async () => {
          return logAttemptsAndClassifyRectifications(supabase, submission.learner_id, exercise.id, scoredResult);
        })
      : [];

    const feedback = await step.run('generate-coaching', async () => {
      const answerKey = await getExerciseAnswerKeyForScoring(supabase, exercise.id, submission.learner_id);
      return generateCoaching(submission.learner_id, {
        overallResult,
        scoringResult,
        qualitative: qualitativeScore,
        answerKey,
        rectificationDescriptions: rectifications.map(describeRectification),
        missingPartDescriptions: stillMissing.map(describeMissingPart),
      });
    });

    await step.run('persist-scoring-result', async () => {
      const errorCodes = scoringResult ? collectErrorCodes(scoringResult) : [];
      await insertScoringResult(supabase, {
        submissionId,
        exerciseId: exercise.id,
        learnerId: submission.learner_id,
        scoringResult,
        errorCodes,
        qualitativeScore,
        overallResult,
        feedback,
      });
      await updateSubmissionStatus(supabase, submissionId, 'scored', null);

      if (scoringResult) {
        recordSubmissionScore({
          learnerId: submission.learner_id,
          submissionId,
          weightedScore: scoringResult.weighted_score,
          overallResult: scoringResult.overall_result,
          tbTieOut: scoringResult.tb_tie_out,
        });
      }
    });

    // The same post-scoring pipeline as run-scoring.ts (shared in
    // advance-learner.ts): mastery/module progress, then the next batch.
    // Missing before 2026-09-02, which left Praveen with a scored Level 3
    // and no Level 4.
    await step.run('recompute-mastery-and-module-progress', async () => {
      await recomputeMasteryAndModuleProgress(supabase, submission.learner_id);
    });

    await step.run('generate-next-exercise', async () => {
      await generateNextExercise(supabase, {
        learnerId: submission.learner_id,
        previousDifficultyLevel: exercise.difficulty_level,
        licenseMode: profile.license_mode,
        afterIso: submission.created_at,
      });
    });

    return { status: 'scored', submissionId, missingParts: stillMissing };
  },
);

const PART_LABEL: Record<SubmissionPartType, string> = {
  daybook_xml: 'the Day Book XML',
  trialbalance_xml: 'the Trial Balance XML',
  explain_text: 'your explanation',
  review_text: 'your ledger review',
};

function describeMissingPart(partType: SubmissionPartType): string {
  return `${PART_LABEL[partType]} never arrived before the review window closed, so this was scored on the parts that did.`;
}
