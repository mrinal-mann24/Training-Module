import type { SupabaseClient } from '@supabase/supabase-js';
import { countHintRequestsForExercise } from '@/lib/db/queries/hint-requests';
import { toHintStep, type HintStep } from '@/lib/schemas/hint';

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
