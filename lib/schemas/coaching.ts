import { z } from 'zod';

// Learner-facing coaching prose only: no error codes, weights, or answer-key
// values ever belong on this schema. Shape matches the pilot agent's message
// structure (Phase 1, spec 13): a score-first opening line, "What went well"
// and "What needs work" bullet sections, and a closing next-step line.
export const CoachingSchema = z.object({
  opening_line: z.string(),
  went_well: z.array(z.string()),
  needs_work: z.array(z.string()),
  next_note: z.string(),
});
export type Coaching = z.infer<typeof CoachingSchema>;

// Rows stored before the Phase 1 schema change carry the original shape
// { result_line, praise, flagged_areas, next_step_note }. The compat mapper
// lives HERE, once: every read path (live feedback fetch and the chat-history
// rebuild) normalizes through it, so the renderer only ever sees the new
// shape and no data migration is needed.
const LegacyCoachingSchema = z.object({
  result_line: z.string(),
  praise: z.string(),
  flagged_areas: z.array(z.string()),
  next_step_note: z.string(),
});

export function normalizeStoredCoaching(raw: unknown): Coaching {
  const current = CoachingSchema.safeParse(raw);
  if (current.success) {
    return current.data;
  }
  const legacy = LegacyCoachingSchema.safeParse(raw);
  if (legacy.success) {
    return {
      opening_line: legacy.data.result_line,
      went_well: legacy.data.praise.trim().length > 0 ? [legacy.data.praise] : [],
      needs_work: legacy.data.flagged_areas,
      next_note: legacy.data.next_step_note,
    };
  }
  // Unrecognizable row (should not happen: both shapes were Zod-validated at
  // write time). Render something honest rather than crashing the chat.
  return {
    opening_line: 'This submission was scored, but the stored feedback could not be read.',
    went_well: [],
    needs_work: [],
    next_note: 'Ask your tutor to take another look.',
  };
}
