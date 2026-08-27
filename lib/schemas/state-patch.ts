import { z } from 'zod';
import { CONCEPT_TAGS } from './exercise';

export const CONCEPT_MASTERY_STATUSES = ['not_started', 'developing', 'mastered'] as const;
export type ConceptMasteryStatus = (typeof CONCEPT_MASTERY_STATUSES)[number];

// Output of the mastery recompute step (lib/tutor/mastery.ts), applied to
// concept_mastery as the one sanctioned write path — see architecture.md
// invariant 5. Not an LLM output: mastery.ts is pure deterministic logic over
// concept_attempts, so this schema exists to keep the recompute step's output
// shape explicit and typed, not to validate untrusted model JSON.
export const StatePatchSchema = z.object({
  concept_mastery_deltas: z.array(
    z.object({
      concept_tag: z.enum(CONCEPT_TAGS),
      new_status: z.enum(CONCEPT_MASTERY_STATUSES),
      consecutive_clean_count: z.number().int().nonnegative(),
      last_attempt_result: z.enum(['pass', 'fail']),
    }),
  ),
  escalation_changes: z.array(
    z.object({
      concept_tag: z.enum(CONCEPT_TAGS),
      escalation_active: z.boolean(),
    }),
  ),
});
export type StatePatch = z.infer<typeof StatePatchSchema>;
