import type { SupabaseClient } from '@supabase/supabase-js';
import { countExercisesForLearner } from '@/lib/db/queries/exercises';
import { getHintDepthForExercise } from '@/lib/db/queries/hint-requests';
import { insertConceptAttempts, getConceptAttempts, getConceptMasteryMap, applyStatePatch } from '@/lib/db/queries/mastery';
import { recomputeMastery, selectWeakConcept } from '@/lib/tutor/mastery';
import { generateAdaptiveExercise } from '@/lib/tutor/generate-exercise';
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

// The previous scored Trial Balance for the movement-based tie-out
// (2026-09-09), shared by both scoring jobs. Null on the first scored
// posting, or when the earlier file cannot be read — the tie-out then falls
// back to the closing comparison rather than failing the submission.
export async function loadPreviousTrialBalance(
  supabase: SupabaseClient,
  learnerId: string,
  beforeCreatedAt: string,
): Promise<ParsedTrialBalance | null> {
  const storagePath = await getPreviousScoredTrialBalancePath(supabase, learnerId, beforeCreatedAt);
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
  scoringResult: ScoringResult,
): Promise<RectificationResult[]> {
  const hintRungsUsed = await getHintDepthForExercise(supabase, learnerId, exerciseId);

  const attemptsThisExercise = scoringResult.concept_results.map((conceptResult) => ({
    conceptTag: conceptResult.concept_tag,
    result: conceptResult.result,
    hintRungsUsed,
  }));
  await insertConceptAttempts(supabase, learnerId, exerciseId, attemptsThisExercise);

  const allAttempts = await getConceptAttempts(supabase, learnerId);
  const conceptTagsThisExercise = scoringResult.concept_results.map((result) => result.concept_tag);
  return classifyRectificationsForExercise(conceptTagsThisExercise, allAttempts);
}

// Re-derives concept_mastery from the full concept_attempts history, then
// evaluates module advancement on top of the fresh mastery state — the one
// sanctioned write path for both tables (architecture.md invariant 5).
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
// weakest at. Idempotent on `afterIso` (the scored submission's created_at):
// if any exercise already exists for the learner newer than that, nothing
// is generated — so an Inngest rerun, or a manual re-trigger for a learner
// left stranded by the pre-fix multi-part job, can never hand out two
// batches for one submission.
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
export function describeRectification(result: RectificationResult): string {
  const conceptLabel = result.conceptTag.replace(/_/g, ' ');
  if (result.classification === 'FIXED') {
    return `${conceptLabel} was failing before and is now fixed`;
  }
  return `${conceptLabel} failed again, same as last time: still failing`;
}
