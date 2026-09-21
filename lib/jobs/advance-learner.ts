import type { SupabaseClient } from '@supabase/supabase-js';
import { countExercisesForLearner, getExerciseAnswerKeyForScoring } from '@/lib/db/queries/exercises';
import {
  getHintDepthByConceptForExercise,
  getLatestHintForExerciseAfter,
  hintDepthForConcept,
  insertHintRequest,
} from '@/lib/db/queries/hint-requests';
import { determineNextRung } from '@/lib/tutor/hint-ladder';
import { generateHint } from '@/lib/tutor/generate-hint';
import { decideCorrection } from '@/lib/tutor/correction-round';
import type { ExerciseForLearner } from '@/lib/db/queries/exercises';
import { insertConceptAttempts, getConceptAttempts, getConceptMasteryMap, applyStatePatch } from '@/lib/db/queries/mastery';
import { recomputeMastery, selectWeakConcept } from '@/lib/tutor/mastery';
import { generateAdaptiveExercise } from '@/lib/tutor/generate-exercise';
import { generatePlannedExercise } from '@/lib/tutor/generate-planned-exercise';
import { getLearnerProfile } from '@/lib/db/queries/learner-profile';
import { generateReviewExercise } from '@/lib/tutor/generate-review-exercise';
import { selectNextExerciseKind } from '@/lib/tutor/select-exercise-kind';
import { isDocumentsModeUnlocked } from '@/lib/tutor/documents-mode';
import { selectBatchConcepts } from '@/lib/tutor/select-batch-concepts';
import { getRecentCompanyTransactionLog } from '@/lib/db/queries/company';
import { ACTIVE_CONCEPT_TAGS, EXERCISE_DIFFICULTY_LEVELS, type ExerciseDifficultyLevel } from '@/lib/schemas/exercise';
import { getModuleProgress, upsertModuleProgress } from '@/lib/db/queries/module-progress';
import { deriveNextModuleProgress } from '@/lib/tutor/module-progress';
import { classifyRectificationsForExercise, type RectificationResult } from '@/lib/tutor/rectification';
import type { ScoringResult } from '@/lib/schemas/scoring';
import type { ParsedTrialBalance } from '@/lib/schemas/voucher';
import { getPreviousScoredTrialBalancePath } from '@/lib/db/queries/submissions';
import { parseTrialBalanceXml } from '@/lib/parsing/trialbalance';
import { expectedClosingBalances, type ExpectedClosing } from '@/lib/tutor/books-reconciliation';
import type { AnswerKey } from '@/lib/schemas/exercise';
import { openAdvancesOf, replayKeys } from '@/lib/tutor/ledger-state';
import type { RectificationNote } from '@/lib/llm/prompts/coaching';

// The previous scored Trial Balance for the movement-based tie-out
// (2026-09-09), shared by both scoring jobs. Null on the first scored
// posting, or when the earlier file cannot be read — the tie-out then falls
// back to the closing comparison rather than failing the submission.
//
// currentExerciseId is excluded from the search (2026-09-16). On a correction
// round the most recent scored submission is the FAILED round of this same
// exercise, so without excluding it the tie-out would measure this month's
// movement against the learner's own wrong version of this month and report
// mismatches that are pure artefact.
export async function loadPreviousTrialBalance(
  supabase: SupabaseClient,
  learnerId: string,
  beforeCreatedAt: string,
  currentExerciseId?: string,
): Promise<ParsedTrialBalance | null> {
  const storagePath = await getPreviousScoredTrialBalancePath(supabase, learnerId, beforeCreatedAt, currentExerciseId);
  if (!storagePath) {
    return null;
  }
  const download = await supabase.storage.from('submissions').download(storagePath);
  if (download.error || !download.data) {
    return null;
  }
  try {
    return parseTrialBalanceXml(Buffer.from(await download.data.arrayBuffer()));
  } catch {
    return null;
  }
}

// Position of an exercise in the learner's timeline (0 = the April pack),
// -1 when it is not found. One batch per month: 0..11 are the first
// financial year, 12..23 the second, so the first batch of a year (12, 24,
// …) is the month in which Tally restarts the profit-and-loss ledgers.
export async function loadExerciseOrdinal(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('exercises')
    .select('id')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: true });
  if (error) {
    throw error;
  }
  return ((data ?? []) as { id: string }[]).findIndex((row) => row.id === exerciseId);
}

export function isFirstMonthOfFinancialYear(ordinal: number): boolean {
  return ordinal > 0 && ordinal % 12 === 0;
}

// The correct books at the point of the batch being scored, for the books
// reconciliation (2026-09-10): every key of the learner in timeline order,
// the batch's ordinal in that order (0 = the April pack). Empty when the
// exercise is not found, so scoring never fails on this feedback-only step.
export async function loadExpectedClosingBalances(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
): Promise<ExpectedClosing[]> {
  const { data, error } = await supabase
    .from('exercises')
    .select('id, answer_key')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: true });
  if (error) {
    throw error;
  }
  const rows = (data ?? []) as { id: string; answer_key: AnswerKey | null }[];
  const ordinal = rows.findIndex((row) => row.id === exerciseId);
  if (ordinal === -1) {
    return [];
  }
  const keys = rows.slice(0, ordinal + 1).map((row) => row.answer_key ?? { entries: [] });
  return expectedClosingBalances(keys, ordinal);
}

// Advances still open in the books before the batch being scored, as the
// canonical references the scorer compares (2026-09-22). A learner who
// adjusts an April advance on a June bill is right even when the stored key
// names only the bill. Empty when the exercise is not found, so scoring
// never fails on it.
export async function loadOpenAdvanceReferences(supabase: SupabaseClient, learnerId: string, exerciseId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('exercises')
    .select('id, answer_key')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: true });
  if (error) {
    throw error;
  }
  const rows = (data ?? []) as { id: string; answer_key: AnswerKey | null }[];
  const ordinal = rows.findIndex((row) => row.id === exerciseId);
  if (ordinal <= 0) {
    return new Set();
  }
  const prior = rows.slice(0, ordinal).map((row) => row.answer_key ?? { entries: [] });
  return new Set(openAdvancesOf(replayKeys(prior)).map((item) => item.key));
}

// The post-scoring pipeline every scored submission goes through, shared by
// BOTH scoring jobs. Until 2026-09-02 only run-scoring.ts (the two-file
// path) logged concept attempts, recomputed mastery/module progress and
// generated the next exercise; wait-for-submission.ts (explain/review
// exercises with a text part) persisted the score and returned — so the
// first learner to finish an explain batch (Praveen, Level 3, 98%) got his
// feedback and then nothing: no Level 4, no mastery update. The step
// bodies live here so the two jobs cannot drift again; the jobs keep their
// own step ids around these calls.

export type LicenseMode = Parameters<typeof generateAdaptiveExercise>[7];

export async function logAttemptsAndClassifyRectifications(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
  submissionId: string,
  scoringResult: ScoringResult,
): Promise<RectificationResult[]> {
  // Per concept, not per exercise (2026-09-16): a concept is charged for the
  // help given ON it, plus any exercise-level "I'm stuck" clicks. Charging
  // every concept for help on one of them would, with the correction loop
  // pushing a hint on every failing batch, deny the clean-pass streak to
  // everything and stall mastery permanently.
  const hintDepth = await getHintDepthByConceptForExercise(supabase, learnerId, exerciseId);

  const attemptsThisExercise = scoringResult.concept_results.map((conceptResult) => ({
    conceptTag: conceptResult.concept_tag,
    result: conceptResult.result,
    hintRungsUsed: hintDepthForConcept(hintDepth, conceptResult.concept_tag),
  }));
  await insertConceptAttempts(supabase, learnerId, exerciseId, submissionId, attemptsThisExercise);

  const allAttempts = await getConceptAttempts(supabase, learnerId);
  const conceptTagsThisExercise = scoringResult.concept_results.map((result) => result.concept_tag);
  // The scored exercise is named explicitly (2026-09-17) so "prior" is this
  // exercise's previous round, or failing that the previous batch's final
  // round, never whichever raw row happens to sort just before it.
  return classifyRectificationsForExercise(conceptTagsThisExercise, allAttempts, exerciseId);
}

// Re-derives concept_mastery from the full concept_attempts history, then
// evaluates module advancement on top of the fresh mastery state — the one
// sanctioned write path for both tables (architecture.md invariant 5).
//
// The raw history goes in whole, every correction round included (2026-09-17):
// recomputeMastery folds rounds to one attempt per exercise itself, so no
// caller can forget to and let one re-submitted batch master or escalate a
// concept. Filtering rows out here instead would lose them from the audit
// trail's only reader.
export async function recomputeMasteryAndModuleProgress(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<void> {
  const [allAttempts, currentMastery] = await Promise.all([
    getConceptAttempts(supabase, learnerId),
    getConceptMasteryMap(supabase, learnerId),
  ]);

  const patch = recomputeMastery({ attempts: allAttempts, currentMastery });
  await applyStatePatch(supabase, learnerId, patch);

  const updatedMastery = await getConceptMasteryMap(supabase, learnerId);
  const currentModuleProgress = await getModuleProgress(supabase, learnerId);
  const nextModuleProgress = deriveNextModuleProgress(currentModuleProgress, updatedMastery);
  await upsertModuleProgress(supabase, learnerId, nextModuleProgress);
}

export type NextExerciseOutcome = 'generated' | 'already-exists' | 'all-mastered';

export const REVIEW_EXERCISES_ENABLED = false;

// Generates the learner's next batch, targeting whatever they are now
// weakest at. Idempotent on `afterIso` — the SCORED EXERCISE's created_at,
// not the submission's: if any exercise already exists for the learner newer
// than the one just scored, nothing is generated. One batch per exercise,
// however many times that exercise is scored.
//
// It was keyed on the submission's created_at until 2026-09-16, which was
// correct while an exercise could only ever be submitted once. Correction
// rounds break that: round 1's re-upload is NEWER than the next exercise
// round 0 generated, so the guard would see nothing after it and generate a
// second batch, with a second difficulty bump. That is precisely the
// production incident hasScoredSubmissionForExercise was added to stop
// ("Yeshas re-uploaded December and got two January batches"), which the
// correction loop deliberately reopens the door to.
export async function generateNextExercise(
  supabase: SupabaseClient,
  params: {
    learnerId: string;
    previousDifficultyLevel: ExerciseDifficultyLevel;
    licenseMode: LicenseMode;
    afterIso: string;
  },
): Promise<NextExerciseOutcome> {
  const { count, error } = await supabase
    .from('exercises')
    .select('id', { count: 'exact', head: true })
    .eq('learner_id', params.learnerId)
    .gt('created_at', params.afterIso);
  if (error) {
    throw error;
  }
  if ((count ?? 0) > 0) {
    return 'already-exists';
  }

  const [allAttempts, currentMastery] = await Promise.all([
    getConceptAttempts(supabase, params.learnerId),
    getConceptMasteryMap(supabase, params.learnerId),
  ]);

  // Retired concepts (narration, 2026-09-10) are never targeted.
  const target = selectWeakConcept(ACTIVE_CONCEPT_TAGS, allAttempts, currentMastery);
  if (!target) {
    // Every concept mastered — no further adaptive exercise to generate.
    return 'all-mastered';
  }

  const baseDifficultyLevel = deriveBaseDifficultyLevel(params.previousDifficultyLevel);

  // Explain/review batches take their place in the cadence; a review that
  // cannot be built (no anomaly templates seeded, sparse company log) falls
  // back to a plain adaptive batch — the learner always gets SOMETHING next.
  const [priorExerciseCount, recentLog] = await Promise.all([
    countExercisesForLearner(supabase, params.learnerId),
    getRecentCompanyTransactionLog(supabase, params.learnerId),
  ]);
  const nextKind = selectNextExerciseKind({
    priorExerciseCount,
    companyTransactionLogCount: recentLog.length,
  });

  // Review batches are OFF until the feature is grounded (2026-09-03). The
  // first one delivered live (Praveen, Level 5) built its "ledger entries"
  // from company_transaction_log rows — which are whole-batch summaries, so
  // each item read as one sentence listing sixty ledgers — had zero real
  // anomalies because anomaly_templates is unseeded, and named a party
  // ("Deccan Traders & Associates") that does not exist. Nothing in it was
  // derived from the books at transaction level. Re-enable only once the
  // review packet is built from real answer-key transactions with
  // deterministic, code-injected anomalies. generateReviewExercise stays
  // importable for that rebuild.
  if (nextKind === 'review' && REVIEW_EXERCISES_ENABLED) {
    try {
      await generateReviewExercise(supabase, params.learnerId, baseDifficultyLevel);
      return 'generated';
    } catch {
      // Fall through to a normal adaptive batch below.
    }
  }

  // The 50/50 batch plan — step-up concepts and reinforcement concepts —
  // computed from the same state the target selection used.
  const batchPlan = selectBatchConcepts(target, allAttempts, currentMastery);
  const recentStrengthDescriptions = batchPlan.strengths.map((tag) => tag.replace(/_/g, ' '));
  // Month-per-batch: the company's timeline advances one calendar month per
  // exercise, anchored on the diagnostic pack's April 2026 —
  // priorExerciseCount includes the diagnostic, so the first adaptive batch
  // lands in May, the next in June, and so on.
  //
  // Rebuild Stage 4 (2026-09-22): a learner flipped to the planned engine
  // gets a batch whose key is built by code from the books; concepts the
  // builder does not yet cover fall back to the legacy generator.
  const profile = await getLearnerProfile(supabase, params.learnerId);
  if (profile?.generation_engine === 'planned') {
    const planned = await generatePlannedExercise(
      supabase,
      params.learnerId,
      target,
      baseDifficultyLevel,
      nextKind === 'explain' ? 'explain' : 'adaptive',
      recentStrengthDescriptions,
      batchPlan,
      params.licenseMode ?? 'licensed',
      priorExerciseCount + 1,
      isDocumentsModeUnlocked(currentMastery.values()),
    );
    if (planned !== 'unsupported') return 'generated';
  }
  await generateAdaptiveExercise(
    supabase,
    params.learnerId,
    target,
    baseDifficultyLevel,
    nextKind === 'explain' ? 'explain' : 'adaptive',
    recentStrengthDescriptions,
    batchPlan,
    params.licenseMode,
    priorExerciseCount + 1,
    isDocumentsModeUnlocked(currentMastery.values()),
  );
  return 'generated';
}

// The submission a failed run belonged to (2026-09-16), read from an
// Inngest inngest/function.failed payload. In SDK 4.18 the original
// triggering event sits at event.data.event (FailureEventPayload,
// node_modules/inngest/types.d.ts), so the id is one level deeper than in the
// function body. Returns null rather than throwing on an unexpected shape: a
// failure handler that itself throws would leave the submission stuck, which
// is the thing it exists to prevent.
export function submissionIdFromFailureEvent(failureEvent: unknown): string | null {
  const original = (failureEvent as { data?: { event?: { data?: { submissionId?: unknown } } } } | null)?.data?.event;
  const submissionId = original?.data?.submissionId;
  return typeof submissionId === 'string' && submissionId.length > 0 ? submissionId : null;
}

export type CorrectionOutcome =
  | { opened: false }
  | { opened: true; round: number; conceptTag: string };

// Injected so the decision can be tested without a Supabase double or a live
// LLM call (code-standards rule 6a). Production passes nothing.
export type CorrectionDeps = {
  nextRung: typeof determineNextRung;
  existingHint: typeof getLatestHintForExerciseAfter;
  loadAnswerKey: typeof getExerciseAnswerKeyForScoring;
  makeHint: typeof generateHint;
  saveHint: typeof insertHintRequest;
  advance: typeof generateNextExercise;
};

// What happens once a submission is scored (2026-09-16): either another
// correction round opens, or the learner moves on to a new batch. Shared by
// both scoring jobs for the same reason every other step body here is.
//
// Opening a round means pushing the NEXT step of the existing 3-step help
// ladder for the concept that failed, and NOT generating a new exercise: the
// learner fixes it in Tally and sends the corrected exports, which are
// scored against the same answer key (invariant 6).
//
// The rung comes from determineNextRung, the same count-based rule the manual
// help button uses, so a learner who already clicked for help does not get a
// step they have seen repeated. This is the resubmission signal
// hint-ladder.ts's own comment asked for: "Revisit if a per-exercise
// resubmission signal ever gates this."
export async function openCorrectionRoundOrAdvance(
  supabase: SupabaseClient,
  params: {
    learnerId: string;
    exercise: ExerciseForLearner;
    submissionCorrectionRound: number;
    // The scored submission's created_at, used only to tell this round's
    // pushed hint apart from earlier rounds' hints.
    submissionScoredAfter: string;
    conceptResults: ScoringResult['concept_results'];
    licenseMode: LicenseMode;
  },
  deps?: Partial<CorrectionDeps>,
): Promise<CorrectionOutcome> {
  const nextRung = deps?.nextRung ?? determineNextRung;
  const existingHint = deps?.existingHint ?? getLatestHintForExerciseAfter;
  const loadAnswerKey = deps?.loadAnswerKey ?? getExerciseAnswerKeyForScoring;
  const makeHint = deps?.makeHint ?? generateHint;
  const saveHint = deps?.saveHint ?? insertHintRequest;
  const advance = deps?.advance ?? generateNextExercise;

  const decision = decideCorrection({
    requiredParts: params.exercise.requiredParts,
    conceptResults: params.conceptResults,
    currentRound: params.submissionCorrectionRound,
  });

  if (decision.kind === 'open') {
    try {
      // Idempotency (2026-09-16, review finding). insertHintRequest has no
      // conflict key, and determineNextRung derives the step from a COUNT of
      // hint rows, so running this body twice for one submission would write
      // a second hint a step deeper than this round deserves, and
      // getLatestHintForExerciseAfter would serve that deeper one. The
      // ladder would then stay permanently ahead of the round counter,
      // handing over the full answer early and costing the learner mastery
      // credit they had not spent. A hint already exists for this round, so
      // the round is already open: say so and write nothing.
      const alreadyPushed = await existingHint(
        supabase,
        params.learnerId,
        params.exercise.id,
        params.submissionScoredAfter,
      );
      if (alreadyPushed) {
        return { opened: true, round: decision.round, conceptTag: decision.focusConceptTag };
      }

      const [rung, answerKey] = await Promise.all([
        nextRung(supabase, params.learnerId, params.exercise.id),
        loadAnswerKey(supabase, params.exercise.id, params.learnerId),
      ]);
      if (!answerKey) {
        throw new Error(`Answer key missing for exercise ${params.exercise.id}.`);
      }

      const hint = await makeHint(params.learnerId, {
        rung,
        scenario: params.exercise.scenario,
        transactions: params.exercise.transactions,
        answerKey,
        packMode: params.exercise.packFiles.length > 0,
        focusConceptTag: decision.focusConceptTag,
        licenseMode: params.licenseMode,
      });

      await saveHint(supabase, params.learnerId, params.exercise.id, hint, decision.focusConceptTag);

      return { opened: true, round: decision.round, conceptTag: decision.focusConceptTag };
    } catch (error) {
      // A help step that cannot be generated must not strand the learner with
      // no hint AND no next batch. Fall through to advancing: the concept is
      // already logged as failing, so it comes back as the next batch's
      // target anyway. Never leave a learner permanently stuck
      // (project-overview.md goal 5) outranks finishing the loop.
      //
      // Logged (review finding, 2026-09-16): the feedback was already written
      // for an open round, so a silent fallback here would leave no trace of
      // why the learner got a new batch instead.
      console.error(
        `[correction] round ${decision.round} for exercise ${params.exercise.id} could not open, advancing instead:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  await advance(supabase, {
    learnerId: params.learnerId,
    previousDifficultyLevel: params.exercise.difficulty_level,
    licenseMode: params.licenseMode,
    // The EXERCISE's created_at, never the submission's: see
    // generateNextExercise's comment. A correction round is newer than the
    // batch it would otherwise generate.
    afterIso: params.exercise.created_at,
  });

  return { opened: false };
}

// The next exercise's starting difficulty before any reinforcement drop is
// applied: one level up from whatever exercise was just scored, capped at
// the highest defined level. generateAdaptiveExercise then drops it back
// down a level if reinforcement is active for the target concept.
export function deriveBaseDifficultyLevel(previousLevel: ExerciseDifficultyLevel): ExerciseDifficultyLevel {
  const index = EXERCISE_DIFFICULTY_LEVELS.indexOf(previousLevel);
  const nextIndex = Math.min(index + 1, EXERCISE_DIFFICULTY_LEVELS.length - 1);
  return EXERCISE_DIFFICULTY_LEVELS[nextIndex];
}

// Plain-language phrasing of a rectification classification, handed to the
// coaching prompt as a fact to weave into prose (never a raw enum value).
//
// NEW returns null (2026-09-16). It used to fall through to the
// STILL_FAILING sentence, "failed again, same as last time", so a learner's
// very first scored batch (Template595) was told a gap had been "flagged in
// an earlier round, still recurring" and "two rounds running". A first-time
// failure is already a needs_work finding; it has no history to state. The
// FIXED/STILL_FAILING lines name where the earlier attempt really was.
export function describeRectification(result: RectificationResult): string | null {
  const conceptLabel = result.conceptTag.replace(/_/g, ' ').replace(/\b(gst|tds)\b/g, (tax) => tax.toUpperCase());
  const where = result.prior === 'previous-round' ? 'the previous round of this batch' : 'the last batch that tested it';
  switch (result.classification) {
    case 'NEW':
      return null;
    case 'FIXED':
      return `${conceptLabel} was failing in ${where} and is fixed now`;
    case 'STILL_FAILING':
      return `${conceptLabel} was failing in ${where} and is still failing now`;
    default:
      return assertNeverClassification(result.classification);
  }
}

function assertNeverClassification(value: never): never {
  throw new Error(`Unhandled rectification classification: ${String(value)}`);
}

// The rectifications that have something true to say, as the coaching call
// takes them: NEW is dropped, the rest carry their classification so the
// grounding check knows which facts may speak about history.
export function describeRectifications(results: RectificationResult[]): RectificationNote[] {
  return results.flatMap((result) => {
    const text = describeRectification(result);
    return text === null || result.classification === 'NEW' ? [] : [{ classification: result.classification, text }];
  });
}
