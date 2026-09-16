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

// Help depth, per concept plus the exercise-wide rows that count against all
// of them. See getHintDepthByConceptForExercise.
export type HintDepthByConcept = { perConcept: Record<string, number>; exerciseWide: number };

export function hintDepthForConcept(depth: HintDepthByConcept, conceptTag: string): number {
  return depth.exerciseWide + (depth.perConcept[conceptTag] ?? 0);
}

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

// conceptTag (2026-09-16) is the concept this help was ABOUT, stored as its
// own column so hint depth can be counted per concept rather than per
// exercise. Pass null for exercise-level help, which is what the manual help
// button sends: the learner clicked "I'm stuck" without saying on what, so
// that request counts against every concept of the batch, exactly as all
// help did before this column existed.
export async function insertHintRequest(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
  hint: Hint,
  conceptTag: string | null = null,
): Promise<HintRequest> {
  const { data, error } = await supabase
    .from('hint_requests')
    .insert({
      learner_id: learnerId,
      exercise_id: exerciseId,
      rung: hint.rung,
      hint_content: hint,
      concept_tag: conceptTag,
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

// Total help requests for an exercise. Still what the chat's help button
// shows ("Help step 2 of 3"), which is deliberately per exercise: one
// learner, one ladder, one button.
export async function getHintDepthForExercise(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
): Promise<number> {
  return countHintRequestsForExercise(supabase, learnerId, exerciseId);
}

// Help depth split by concept (2026-09-16), which is what mastery credit
// must use. isCleanPass denies the streak to any pass with 3 or more help
// requests behind it; charging every concept in a batch for help given on
// ONE of them was survivable while help was rare and learner-initiated, but
// the correction loop pushes a hint on every failing batch. Left per
// exercise, a learner in the loop would never master anything again and the
// dashboard bar would sit at zero forever.
//
// exerciseWide counts rows with no concept (legacy rows and the manual help
// button) and is added to every concept's total, so existing data scores
// exactly as it did before.
export async function getHintDepthByConceptForExercise(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
): Promise<{ perConcept: Record<string, number>; exerciseWide: number }> {
  const { data, error } = await supabase
    .from('hint_requests')
    .select('concept_tag')
    .eq('learner_id', learnerId)
    .eq('exercise_id', exerciseId);

  if (error) {
    throw error;
  }

  const perConcept: Record<string, number> = {};
  let exerciseWide = 0;

  for (const row of (data ?? []) as { concept_tag: string | null }[]) {
    if (row.concept_tag === null) {
      exerciseWide += 1;
      continue;
    }
    perConcept[row.concept_tag] = (perConcept[row.concept_tag] ?? 0) + 1;
  }

  return { perConcept, exerciseWide };
}

// The help pushed by a correction round (2026-09-16), which the chat polls
// for after scoring. Scoped to hints created AFTER the submission that
// triggered it, so the poll can never resurface a hint the learner already
// read earlier in the same exercise.
export async function getLatestHintForExerciseAfter(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
  afterIso: string,
): Promise<Hint | null> {
  const { data, error } = await supabase
    .from('hint_requests')
    .select('hint_content')
    .eq('learner_id', learnerId)
    .eq('exercise_id', exerciseId)
    .gt('created_at', afterIso)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data?.hint_content as Hint | undefined) ?? null;
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
