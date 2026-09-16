import { ACTIVE_CONCEPT_TAGS, type ConceptTag, type SubmissionPartType } from '@/lib/schemas/exercise';

// Pure rules for the correction loop (2026-09-16). No DB, no LLM: the jobs
// and the chat action both decide through this file, so "is a correction
// open?" has exactly one answer everywhere.
//
// The loop: a batch that got something wrong does not immediately hand out
// the next one. The tutor gives the next step of the existing 3-step help
// ladder, the learner fixes it in Tally and sends the corrected exports, and
// that re-upload is scored against the SAME answer key (architecture.md
// invariant 6 already allows this: "the same answer key that scored the
// first submission for that exercise scores any resubmission for it").
//
// Three rounds, one per help step. By the third the learner has been handed
// the full worked answer, so the loop closes whatever the result: the
// product's rule is that nobody is left permanently stuck, not that nobody
// moves on until they are perfect.
export const MAX_CORRECTION_ROUNDS = 3;

// Only the plain two-file batches (diagnostic and adaptive) take corrections.
// An explain batch's submission also carries a text part the learner already
// wrote, and a review batch has no Tally upload at all, so a "send the
// corrected exports" round has nothing coherent to mean for either: the
// re-upload would sit in the 45-minute multi-part wait window waiting for a
// part that is never coming. Those batches advance as they always did.
export function supportsCorrectionRounds(requiredParts: readonly SubmissionPartType[]): boolean {
  return (
    requiredParts.length === 2 &&
    requiredParts.includes('daybook_xml') &&
    requiredParts.includes('trialbalance_xml')
  );
}

export type ConceptOutcome = { concept_tag: ConceptTag; result: 'pass' | 'fail' };

// Failing concepts, in curriculum order rather than the order the scorer
// happened to emit them, so the concept the tutor helps with is stable
// across re-runs of the same submission.
export function failingConcepts(conceptResults: readonly ConceptOutcome[]): ConceptTag[] {
  const failing = new Set<string>(
    conceptResults.filter((outcome) => outcome.result === 'fail').map((outcome) => outcome.concept_tag),
  );
  return ACTIVE_CONCEPT_TAGS.filter((tag) => failing.has(tag));
}

export type CorrectionDecision =
  | {
      kind: 'open';
      round: number;
      focusConceptTag: ConceptTag;
      failingConceptTags: ConceptTag[];
    }
  | { kind: 'advance'; reason: 'not-supported' | 'nothing-failing' | 'rounds-exhausted' };

// What happens after a submission is scored: open another correction round,
// or move the learner on to the next batch.
export function decideCorrection(params: {
  requiredParts: readonly SubmissionPartType[];
  conceptResults: readonly ConceptOutcome[];
  currentRound: number;
}): CorrectionDecision {
  if (!supportsCorrectionRounds(params.requiredParts)) {
    return { kind: 'advance', reason: 'not-supported' };
  }

  const failing = failingConcepts(params.conceptResults);
  if (failing.length === 0) {
    return { kind: 'advance', reason: 'nothing-failing' };
  }

  const round = params.currentRound + 1;
  if (round > MAX_CORRECTION_ROUNDS) {
    return { kind: 'advance', reason: 'rounds-exhausted' };
  }

  return { kind: 'open', round, focusConceptTag: failing[0], failingConceptTags: failing };
}

// Whether a learner may send another set of exports for this exercise. The
// caller reads the latest scored submission's round and whether anything
// failed on it; this is the rule both submitFiles and the scoring job apply.
export function isCorrectionOpen(params: {
  requiredParts: readonly SubmissionPartType[];
  latestRound: number;
  anyConceptFailed: boolean;
}): boolean {
  return (
    supportsCorrectionRounds(params.requiredParts) &&
    params.anyConceptFailed &&
    params.latestRound < MAX_CORRECTION_ROUNDS
  );
}

// The line that follows the pushed hint, inviting the corrected exports. No
// em dashes (learner-facing hard rule).
export function correctionInviteLine(round: number): string {
  if (round >= MAX_CORRECTION_ROUNDS) {
    return 'That is the full answer. Post it in Tally, send me the corrected Day Book and Trial Balance, and we will move on after that.';
  }
  if (round === 2) {
    return 'Give it another go in Tally, then send me the corrected Day Book and Trial Balance.';
  }
  return 'Fix that in Tally, then send me the corrected Day Book and Trial Balance and I will take another look.';
}
