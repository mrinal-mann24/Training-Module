import type { SupabaseClient } from '@supabase/supabase-js';
import { countHintRequestsForExercise, getLatestDeepHintForExercise } from '@/lib/db/queries/hint-requests';
import { toHintStep, type Hint, type HintStep } from '@/lib/schemas/hint';

// Phase 3 (spec 15): the 3-step query response. Step = (count of prior help
// requests for this exercise) + 1, capped at 3. Once step 3 (the full
// answer) has been given, every further request returns step 3 again —
// never errors, never dead-ends, never repeats an earlier step.
//
// ASSUMPTION (spec 15 Goal 1 says "advance a step only on a genuine
// attempt"): there is no signal distinguishing a genuine retry from an
// immediate re-click — the learner works in Tally, invisibly to us, between
// requests. Each help request is treated as "I tried and I'm still stuck",
// which is also how the pilot's reviewers escalated. Revisit if a
// per-exercise resubmission signal ever gates this.
export async function determineNextRung(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
): Promise<HintStep> {
  const priorRequestCount = await countHintRequestsForExercise(supabase, learnerId, exerciseId);
  return toHintStep(priorRequestCount + 1);
}

// Step-3 reuse (2026-08-27): once the full answer exists for this exercise,
// every later step-3 request repeats THAT stored answer instead of
// generating a fresh one. Regeneration picked a different random transaction
// per click on pack exercises, leaking the authored key one entry at a time.
// Steps 1 and 2 never reuse and never look. Reused content is always
// reported as step 3, including legacy rows stored at rung 4 or 5.
export async function findReusableDeepHint(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
  rung: HintStep,
): Promise<Hint | null> {
  if (rung !== 3) {
    return null;
  }

  const stored = await getLatestDeepHintForExercise(supabase, learnerId, exerciseId);
  return stored ? { ...stored.hint_content, rung: 3 } : null;
}
