import type { ConceptTag } from '@/lib/schemas/exercise';
import type { ConceptAttempt } from '@/lib/db/queries/mastery';

export const RECTIFICATION_CLASSIFICATIONS = ['FIXED', 'STILL_FAILING', 'NEW'] as const;
export type RectificationClassification = (typeof RECTIFICATION_CLASSIFICATIONS)[number];

export type RectificationResult = {
  conceptTag: ConceptTag;
  classification: RectificationClassification;
};

// Pure function, no LLM call. Given a concept touched by the current
// exercise and its full concept_attempts history (oldest-first, from Unit
// 09's getConceptAttempts — includes the just-logged attempt for this
// exercise as the latest row), classifies the *latest* attempt on that
// concept:
//   - FIXED: the immediately prior attempt failed, this one passed.
//   - STILL_FAILING: the immediately prior attempt failed, this one failed
//     again.
//   - NEW: this is the first attempt ever recorded for this concept, and it
//     failed.
//   - null: no classification — either the latest attempt passed with no
//     prior failure (steady progress, not a rectification event), or there's
//     no history at all for this concept (shouldn't happen for a concept
//     just attempted, but not this function's place to assume).
export function classifyRectification(
  conceptTag: ConceptTag,
  attemptHistory: ConceptAttempt[],
): RectificationResult | null {
  const conceptAttempts = attemptHistory
    .filter((attempt) => attempt.concept_tag === conceptTag)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  if (conceptAttempts.length === 0) {
    return null;
  }

  const latest = conceptAttempts[conceptAttempts.length - 1];
  const prior = conceptAttempts.length >= 2 ? conceptAttempts[conceptAttempts.length - 2] : null;

  if (prior === null) {
    if (latest.result === 'fail') {
      return { conceptTag, classification: 'NEW' };
    }
    return null;
  }

  if (prior.result === 'fail' && latest.result === 'pass') {
    return { conceptTag, classification: 'FIXED' };
  }

  if (prior.result === 'fail' && latest.result === 'fail') {
    return { conceptTag, classification: 'STILL_FAILING' };
  }

  // prior passed — whether latest passed again (steady progress) or failed
  // for the first time after a pass (a plain new failure, not a "STILL
  // FAILING" recurrence, since nothing was failing immediately before this),
  // neither is a rectification event worth calling out per the spec.
  return null;
}

// Classifies every concept touched by the current exercise in one call —
// the shape lib/tutor/generate-coaching.ts's caller actually has (a list of
// concept results just logged), rather than one concept at a time.
export function classifyRectificationsForExercise(
  conceptTagsThisExercise: ConceptTag[],
  attemptHistory: ConceptAttempt[],
): RectificationResult[] {
  return conceptTagsThisExercise
    .map((conceptTag) => classifyRectification(conceptTag, attemptHistory))
    .filter((result): result is RectificationResult => result !== null);
}
