import type { SubmissionPartType } from '@/lib/schemas/exercise';

// How long a multi-part submission waits for each missing part, per the
// spec's "30-45 minutes" window. Unchanged from the original single wait.
export const WAIT_WINDOW_MINUTES = 45;

// The wait is taken in slices of this length, re-reading the database between
// them (2026-09-16). WAIT_SLICE_TIMEOUT is the same duration spelled the way
// step.waitForEvent requires; wait-for-parts.test.ts keeps the two in step.
export const WAIT_SLICE_MINUTES = 2;
export const WAIT_SLICE_TIMEOUT = '2m';
export const WAIT_SLICES = Math.ceil(WAIT_WINDOW_MINUTES / WAIT_SLICE_MINUTES);

// The part of Inngest's `step` this needs, narrowed so a test can pass a fake.
export type PartWaitStep = {
  run: (id: string, fn: () => Promise<SubmissionPartType[]>) => Promise<SubmissionPartType[]>;
  waitForEvent: (id: string, options: { event: string; timeout: typeof WAIT_SLICE_TIMEOUT; if: string }) => Promise<unknown>;
};

// Waits until every required part of a submission is in the database, or the
// window for a missing part runs out, whichever comes first.
//
// Why slices (2026-09-16). This used to be one check followed by one 45-minute
// step.waitForEvent per missing part. Those are separate steps, and
// waitForEvent never looks back at events sent before it was registered, so a
// part that arrived in the gap between the check and the wait was invisible:
// the run sat the full 45 minutes and then scored as if the part had never
// come, with it sitting in the database the whole time. That happens whenever
// a learner confirms an explanation within moments of uploading the files.
//
// Now each slice re-reads the database before waiting again, so a missed event
// costs at most one slice. The same property heals a part whose event was
// never sent at all (the send failed): any running job finds it on its next
// read. The event still ends a slice early, so the normal case stays instant.
//
// Step ids carry the slice number because Inngest requires unique ids.
// Semantics per part are unchanged: at most WAIT_WINDOW_MINUTES of waiting,
// then the loop moves on and scoring proceeds with whatever arrived.
export async function waitForRequiredParts(
  step: PartWaitStep,
  params: {
    submissionId: string;
    requiredParts: readonly SubmissionPartType[];
    readReceivedParts: () => Promise<SubmissionPartType[]>;
  },
): Promise<void> {
  for (const partType of params.requiredParts) {
    for (let slice = 0; ; slice++) {
      const received = await step.run(`check-part-${partType}-${slice}`, params.readReceivedParts);
      if (received.includes(partType) || slice >= WAIT_SLICES) {
        break;
      }

      // The return value is deliberately unused: whether the event matched or
      // the slice timed out, the next check re-reads the database, which is
      // the source of truth. An event for a different part can never be
      // misread as this part arriving.
      await step.waitForEvent(`wait-for-${partType}-${slice}`, {
        event: 'submission/part-received',
        timeout: WAIT_SLICE_TIMEOUT,
        if: `async.data.submissionId == "${params.submissionId}" && async.data.partType == "${partType}"`,
      });
    }
  }
}
