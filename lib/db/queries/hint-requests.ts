import type { SupabaseClient } from '@supabase/supabase-js';
import type { Hint, HintRung } from '@/lib/schemas/hint';

export type HintRequest = {
  id: string;
  exercise_id: string;
  learner_id: string;
  rung: HintRung;
  hint_content: Hint;
  created_at: string;
};

// Count of prior hint requests for this exercise — the only input the rung
// progression logic (hint-ladder.ts) needs. Scoped to exercise_id + learner_id
// so hints on one exercise never affect rung state on another.
export async function countHintRequestsForExercise(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('hint_requests')
    .select('id', { count: 'exact', head: true })
    .eq('learner_id', learnerId)
    .eq('exercise_id', exerciseId);

  if (error) {
    throw error;
  }

  return count ?? 0;
}

export async function insertHintRequest(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
  hint: Hint,
): Promise<HintRequest> {
  const { data, error } = await supabase
    .from('hint_requests')
    .insert({
      learner_id: learnerId,
      exercise_id: exerciseId,
      rung: hint.rung,
      hint_content: hint,
    })
    .select('id, exercise_id, learner_id, rung, hint_content, created_at')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

// Step-3 reuse (2026-08-27): once the full answer has been given for an
// exercise, later help clicks return the SAME stored step-3 content instead
// of generating a fresh one. Regenerating picked a different random
// transaction each click on pack exercises, leaking the authored answer key
// one entry per click. rung >= 3 also matches legacy 5-rung rows (4 and 5
// were the deep rungs, reinterpreted as step 3).
export async function getLatestDeepHintForExercise(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
): Promise<HintRequest | null> {
  const { data, error } = await supabase
    .from('hint_requests')
    .select('id, exercise_id, learner_id, rung, hint_content, created_at')
    .eq('learner_id', learnerId)
    .eq('exercise_id', exerciseId)
    .gte('rung', 3)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

// Unit 09 will read this to factor hint-rung depth into mastery credit; this
// unit only needs to make it correctly queryable, not consume it.
export async function getHintDepthForExercise(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
): Promise<number> {
  return countHintRequestsForExercise(supabase, learnerId, exerciseId);
}

// Chat-history rebuild: every hint the learner has received, oldest first.
export async function getHintRequestsForLearner(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<HintRequest[]> {
  const { data, error } = await supabase
    .from('hint_requests')
    .select('id, exercise_id, learner_id, rung, hint_content, created_at')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  return data ?? [];
}
