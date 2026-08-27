import { z } from 'zod';

// Phase 3 (spec 15): the manager's 3-step query response replaced the
// original 5-rung ladder. New help requests only ever produce steps 1-3.
export const HINT_STEPS = [1, 2, 3] as const;
export type HintStep = (typeof HINT_STEPS)[number];

// Stored hint_requests rows predate the 3-step flow and can carry rung 4 or
// 5 (the old ladder's stated-rule and worked-answer rungs). The DB column and
// this stored type stay wide; display and depth logic clamp with toHintStep.
export type HintRung = 1 | 2 | 3 | 4 | 5;

// Legacy rungs 4-5 read as step 3: both were "the answer is being handed
// over" depths, which is exactly what step 3 is now.
export function toHintStep(rung: number): HintStep {
  if (rung <= 1) {
    return 1;
  }
  if (rung === 2) {
    return 2;
  }
  return 3;
}

// LLM-facing help content only — rendered prose plus a concept tag for the
// step-1 video-module pointer. Never carries the raw answer_key structure,
// even on step 3 (the full worked answer is composed prose, not a copy of
// the answer key object).
export const HintSchema = z.object({
  rung: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  hint_text: z.string(),
  concept_tag: z.string(),
});
export type Hint = z.infer<typeof HintSchema>;
