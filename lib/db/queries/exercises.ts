import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AnswerKey,
  ExerciseDifficultyLevel,
  ExerciseKind,
  ExerciseVariant,
  GeneratedExercise,
  ReviewExerciseScenario,
  SubmissionPartType,
} from '@/lib/schemas/exercise';
import { REQUIRED_PARTS_BY_KIND } from '@/lib/schemas/exercise';

export type { ExerciseKind };

// Client-facing shape only — deliberately has no answer_key field, so it's
// impossible to accidentally serialize the answer key into a response even if
// a caller forgets to destructure carefully. transactions is empty for a
// 'review' exercise (its content lives in reviewPacketItems instead) —
// callers render whichever of the two is non-empty for the exercise's kind.
export type ExerciseForLearner = {
  id: string;
  kind: ExerciseKind;
  scenario: string;
  transactions: { sequence: number; description: string }[];
  // Unit 14R: pack-based exercises carry their transactions inside authored
  // files (xlsx registers, bank statement), not in the chat scenario —
  // packFiles names them (signed to URLs at render time from the shared
  // 'packs' bucket) and expectedVoucherCount replaces transactions.length as
  // the validity gate's voucher-count source. Both empty/null for generated
  // exercises.
  packFiles: { label: string; storage_path: string }[];
  expectedVoucherCount: number | null;
  reviewPacketItems: { sequence: number; presented_text: string }[];
  difficulty_level: ExerciseDifficultyLevel;
  variant: ExerciseVariant;
  requiredParts: SubmissionPartType[];
  created_at: string;
};

export async function insertExercise(
  supabase: SupabaseClient,
  learnerId: string,
  kind: ExerciseKind,
  exercise: GeneratedExercise,
): Promise<{ id: string }> {
  const { scenario, transactions, difficulty_level, variant, answer_key } = exercise;

  const { data, error } = await supabase
    .from('exercises')
    .insert({
      learner_id: learnerId,
      kind,
      scenario: { scenario, transactions, difficulty_level, variant },
      answer_key,
      variant,
      required_parts: REQUIRED_PARTS_BY_KIND[kind],
    })
    .select('id')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

// Unit 11: 'review' exercises have no Tally posting/answer_key.entries — the
// scenario itself carries packet_items instead of transactions, and the
// review packet's real answer key lives in ledger_review_items, not
// exercises.answer_key. answer_key.entries is persisted empty for these rows
// (AnswerKeySchema still requires the column, but never carries anything for
// a review exercise — score-qualitative.ts grounds against
// ledger_review_items instead).
export async function insertReviewExercise(
  supabase: SupabaseClient,
  learnerId: string,
  scenario: ReviewExerciseScenario,
): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('exercises')
    .insert({
      learner_id: learnerId,
      kind: 'review',
      scenario: {
        scenario: scenario.scenario,
        packet_items: scenario.packet_items,
        difficulty_level: scenario.difficulty_level,
      },
      answer_key: { entries: [] },
      variant: scenario.variant,
      required_parts: REQUIRED_PARTS_BY_KIND.review,
    })
    .select('id')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

type StoredScenario = {
  scenario: string;
  transactions?: { sequence: number; description: string }[];
  packet_items?: { sequence: number; presented_text: string }[];
  pack_files?: { label: string; storage_path: string }[];
  difficulty_level: ExerciseDifficultyLevel;
};

// Unit 14R: creates a learner's diagnostic exercise from an authored pack.
// The pack's answer key is COPIED into this row (not referenced), so
// invariant 6 (per-exercise answer-key immutability) holds even if the pack
// is re-seeded later. scenario carries the personalized day-1 message and the
// pack file list; transactions stays empty (they live in the files) and
// expected_voucher_count carries the gate's voucher-count expectation.
export async function insertPackExercise(
  supabase: SupabaseClient,
  learnerId: string,
  pack: {
    variant: ExerciseVariant;
    day1Message: string;
    packFiles: { label: string; storage_path: string }[];
    answerKey: AnswerKey;
    expectedVoucherCount: number;
  },
): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('exercises')
    .insert({
      learner_id: learnerId,
      kind: 'diagnostic',
      scenario: {
        scenario: pack.day1Message,
        transactions: [],
        pack_files: pack.packFiles,
        difficulty_level: 'L0',
      },
      answer_key: pack.answerKey,
      variant: pack.variant,
      required_parts: REQUIRED_PARTS_BY_KIND.diagnostic,
      expected_voucher_count: pack.expectedVoucherCount,
    })
    .select('id')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

function toExerciseForLearner(row: {
  id: string;
  kind: ExerciseKind;
  scenario: unknown;
  variant: ExerciseVariant;
  required_parts: SubmissionPartType[];
  expected_voucher_count: number | null;
  created_at: string;
}): ExerciseForLearner {
  const scenario = row.scenario as StoredScenario;

  return {
    id: row.id,
    kind: row.kind,
    scenario: scenario.scenario,
    transactions: scenario.transactions ?? [],
    reviewPacketItems: scenario.packet_items ?? [],
    packFiles: scenario.pack_files ?? [],
    expectedVoucherCount: row.expected_voucher_count ?? null,
    difficulty_level: scenario.difficulty_level,
    variant: row.variant,
    requiredParts: row.required_parts,
    created_at: row.created_at,
  };
}

const EXERCISE_FOR_LEARNER_SELECT = 'id, kind, scenario, variant, required_parts, expected_voucher_count, created_at';

export async function getLatestDiagnosticExercise(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<ExerciseForLearner | null> {
  // Explicitly excludes answer_key from the select — never relies on RLS alone
  // to hide a column within a row the learner does own.
  const { data, error } = await supabase
    .from('exercises')
    .select(EXERCISE_FOR_LEARNER_SELECT)
    .eq('learner_id', learnerId)
    .eq('kind', 'diagnostic')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? toExerciseForLearner(data) : null;
}

// Fetches the learner's single most recent exercise regardless of kind
// (diagnostic, adaptive, explain, or review) — Unit 09's adaptive loop means
// the "current" exercise is no longer always the diagnostic. Same
// answer_key exclusion as getLatestDiagnosticExercise, which remains as-is
// for the one call site that specifically needs the diagnostic
// (confirmWalkthrough).
export async function getLatestExercise(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<ExerciseForLearner | null> {
  const { data, error } = await supabase
    .from('exercises')
    .select(EXERCISE_FOR_LEARNER_SELECT)
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? toExerciseForLearner(data) : null;
}

// Fetches a specific exercise by ID (rather than "latest for learner") — the
// scoring job has a submission's exercise_id, not just a learner_id, and a
// resubmission must always score against the same exercise it was created
// against, not whatever is currently "latest." Same answer_key exclusion as
// getLatestDiagnosticExercise.
export async function getExerciseById(
  supabase: SupabaseClient,
  exerciseId: string,
): Promise<ExerciseForLearner | null> {
  const { data, error } = await supabase
    .from('exercises')
    .select(EXERCISE_FOR_LEARNER_SELECT)
    .eq('id', exerciseId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? toExerciseForLearner(data) : null;
}

// Server-only: fetches the hidden answer_key for scoring. Must only ever be
// called from server-side scoring code (score-submission.ts's caller), never
// exposed through any code path that shapes a client-facing response — see
// architecture.md's hidden-answer-key invariant.
export async function getExerciseAnswerKey(
  supabase: SupabaseClient,
  exerciseId: string,
): Promise<AnswerKey | null> {
  const { data, error } = await supabase
    .from('exercises')
    .select('answer_key')
    .eq('id', exerciseId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  return data.answer_key as AnswerKey;
}

// Unit 14R wiring: how many exercises the learner already has, used by
// select-exercise-kind.ts to place explain/review batches in the cadence.
export async function countExercisesForLearner(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('exercises')
    .select('id', { count: 'exact', head: true })
    .eq('learner_id', learnerId);

  if (error) {
    throw error;
  }

  return count ?? 0;
}

// Chat-history rebuild (lib/chat/build-timeline.ts): every exercise the
// learner has received, oldest first — each becomes one timeline message.
// Same answer_key exclusion as every other learner-facing select here.
export async function getExercisesForLearner(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<ExerciseForLearner[]> {
  const { data, error } = await supabase
    .from('exercises')
    .select(EXERCISE_FOR_LEARNER_SELECT)
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map(toExerciseForLearner);
}
