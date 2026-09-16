import type { SubmissionPartType, TextPartType } from '@/lib/schemas/exercise';

// Which part a typed answer fills on the learner's current exercise: the
// explanation on an explain exercise, the review on a review exercise, and
// nothing on a files-only exercise. The explanation wins if both are required.
export function textPartTypeFor(requiredParts: readonly SubmissionPartType[]): TextPartType | null {
  if (requiredParts.includes('explain_text')) {
    return 'explain_text';
  }
  if (requiredParts.includes('review_text')) {
    return 'review_text';
  }
  return null;
}

export type SubmissionEvent =
  | { name: 'submission/uploaded'; data: { submissionId: string } }
  | { name: 'submission/part-received'; data: { submissionId: string; partType: SubmissionPartType } };

// Unit 11: exercises with exactly the original two required parts
// (diagnostic/adaptive, daybook_xml + trialbalance_xml) keep sending
// submission/uploaded, routing through Unit 07's original run-scoring job
// unchanged, per the spec's explicit "don't route simple submissions through
// the more complex waiting logic unnecessarily." An 'explain' exercise has
// more than two required parts (it also needs explain_text), so it routes
// through submission/part-received into wait-for-submission.ts instead, with
// one event per file: the job's per-part waitForEvent calls match on
// partType, so whichever part it is parked on needs its own event to wake.
export function fileSubmissionEvents(
  submissionId: string,
  requiredParts: readonly SubmissionPartType[],
): SubmissionEvent | SubmissionEvent[] {
  if (requiredParts.length === 2) {
    return { name: 'submission/uploaded', data: { submissionId } };
  }

  return [
    { name: 'submission/part-received', data: { submissionId, partType: 'daybook_xml' } },
    { name: 'submission/part-received', data: { submissionId, partType: 'trialbalance_xml' } },
  ];
}
