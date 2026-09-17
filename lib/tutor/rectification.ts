import type { ConceptTag } from '@/lib/schemas/exercise';
import type { ConceptAttempt } from '@/lib/db/queries/mastery';
import { collapseCorrectionRounds } from '@/lib/tutor/mastery';

export const RECTIFICATION_CLASSIFICATIONS = ['FIXED', 'STILL_FAILING', 'NEW'] as const;
export type RectificationClassification = (typeof RECTIFICATION_CLASSIFICATIONS)[number];

// Where the attempt being compared against came from (2026-09-16). A
// correction round re-scores the SAME exercise, so "the attempt before this
// one" is either an earlier round of this batch or a different, earlier
// batch, and the learner-facing line has to say which. Null for NEW, which
// has no prior attempt at all. Before this existed the coaching told a
// learner on their very first scored batch that a gap was "flagged in an
// earlier round, still recurring" (Template595, 2026-09-16).
export type RectificationPriorContext = 'previous-round' | 'earlier-batch';

export type RectificationResult = {
  conceptTag: ConceptTag;
  classification: RectificationClassification;
  prior: RectificationPriorContext | null;
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
//
// Which attempt counts as "prior" (2026-09-17, alongside mastery's
// collapseCorrectionRounds): the previous ROUND of the same exercise when
// there is one, otherwise the previous EXERCISE's final round, i.e. that
// batch's effective result with its own rounds folded together. Picking the
// raw row just before the latest one only agreed with this while rounds and
// batches never interleave; a late round of an older batch would otherwise
// be compared against a newer batch and told it was "the last batch".
//
// currentExerciseId names the exercise just scored. Without it the exercise
// of the newest row for the concept is used, which is the same thing in the
// normal flow.
export function classifyRectification(
  conceptTag: ConceptTag,
  attemptHistory: ConceptAttempt[],
  currentExerciseId?: string,
): RectificationResult | null {
  const conceptAttempts = attemptHistory
    .filter((attempt) => attempt.concept_tag === conceptTag)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

  if (conceptAttempts.length === 0) {
    return null;
  }

  const exerciseId = currentExerciseId ?? conceptAttempts[conceptAttempts.length - 1].exercise_id;
  const rounds = conceptAttempts.filter((attempt) => attempt.exercise_id === exerciseId);
  if (rounds.length === 0) {
    return null;
  }

  const latest = rounds[rounds.length - 1];
  const prior = rounds.length >= 2 ? rounds[rounds.length - 2] : previousExerciseAttempt(conceptAttempts, exerciseId);

  if (prior === null) {
    if (latest.result === 'fail') {
      return { conceptTag, classification: 'NEW', prior: null };
    }
    return null;
  }

  const priorContext: RectificationPriorContext =
    prior.exercise_id === latest.exercise_id ? 'previous-round' : 'earlier-batch';

  if (prior.result === 'fail' && latest.result === 'pass') {
    return { conceptTag, classification: 'FIXED', prior: priorContext };
  }

  if (prior.result === 'fail' && latest.result === 'fail') {
    return { conceptTag, classification: 'STILL_FAILING', prior: priorContext };
  }

  // prior passed — whether latest passed again (steady progress) or failed
  // for the first time after a pass (a plain new failure, not a "STILL
  // FAILING" recurrence, since nothing was failing immediately before this),
  // neither is a rectification event worth calling out per the spec.
  return null;
}

// The final round of the most recent exercise, before this one, that tested
// the concept. "Before" is by first attempt, the same sequencing mastery
// uses, so a batch's place in the timeline does not move when a late round
// of it lands.
function previousExerciseAttempt(conceptAttempts: ConceptAttempt[], exerciseId: string): ConceptAttempt | null {
  const effective = collapseCorrectionRounds(conceptAttempts);
  const index = effective.findIndex((attempt) => attempt.exercise_id === exerciseId);
  return index > 0 ? effective[index - 1] : null;
}

// Classifies every concept touched by the current exercise in one call —
// the shape lib/tutor/generate-coaching.ts's caller actually has (a list of
// concept results just logged), rather than one concept at a time.
export function classifyRectificationsForExercise(
  conceptTagsThisExercise: ConceptTag[],
  attemptHistory: ConceptAttempt[],
  currentExerciseId?: string,
): RectificationResult[] {
  return conceptTagsThisExercise
    .map((conceptTag) => classifyRectification(conceptTag, attemptHistory, currentExerciseId))
    .filter((result): result is RectificationResult => result !== null);
}
