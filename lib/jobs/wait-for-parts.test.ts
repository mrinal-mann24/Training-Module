import { describe, expect, it } from 'vitest';
import type { SubmissionPartType } from '@/lib/schemas/exercise';
import {
  WAIT_SLICES,
  WAIT_SLICE_MINUTES,
  WAIT_SLICE_TIMEOUT,
  WAIT_WINDOW_MINUTES,
  waitForRequiredParts,
  type PartWaitStep,
} from './wait-for-parts';

const REQUIRED: SubmissionPartType[] = ['daybook_xml', 'trialbalance_xml', 'explain_text'];

// A fake step that records every call. `arrivals` maps a part to the check
// number (counted across the whole run) from which the database has it.
function fakeStep(initial: SubmissionPartType[], arrivals: Partial<Record<SubmissionPartType, number>> = {}) {
  const calls: string[] = [];
  const waits: { id: string; timeout: string; if: string }[] = [];
  let checks = 0;

  const readReceivedParts = async (): Promise<SubmissionPartType[]> => {
    const present = [...initial];
    for (const [part, fromCheck] of Object.entries(arrivals) as [SubmissionPartType, number][]) {
      if (checks >= fromCheck && !present.includes(part)) {
        present.push(part);
      }
    }
    return present;
  };

  const step: PartWaitStep = {
    run: async (id, fn) => {
      calls.push(id);
      const result = await fn();
      checks += 1;
      return result;
    },
    waitForEvent: async (id, options) => {
      calls.push(id);
      waits.push({ id, timeout: options.timeout, if: options.if });
      return null;
    },
  };

  return { step, calls, waits, readReceivedParts };
}

describe('wait slice constants', () => {
  it('keeps the spelled timeout and the minute count in step', () => {
    expect(WAIT_SLICE_TIMEOUT).toBe(`${WAIT_SLICE_MINUTES}m`);
  });

  it('covers at least the full per-part window', () => {
    expect(WAIT_SLICES * WAIT_SLICE_MINUTES).toBeGreaterThanOrEqual(WAIT_WINDOW_MINUTES);
  });
});

describe('waitForRequiredParts', () => {
  it('never waits when every part is already in', async () => {
    const { step, waits, readReceivedParts } = fakeStep(REQUIRED);

    await waitForRequiredParts(step, { submissionId: 'sub-1', requiredParts: REQUIRED, readReceivedParts });

    expect(waits).toHaveLength(0);
  });

  it('waits one slice for a missing part and stops as soon as it appears', async () => {
    // Checks 0 and 1 are the two file parts; check 2 finds no explanation;
    // after one slice, check 3 finds it.
    const { step, waits, readReceivedParts } = fakeStep(['daybook_xml', 'trialbalance_xml'], { explain_text: 3 });

    await waitForRequiredParts(step, { submissionId: 'sub-1', requiredParts: REQUIRED, readReceivedParts });

    expect(waits.map((wait) => wait.id)).toEqual(['wait-for-explain_text-0']);
  });

  // The live bug: the part lands in the database but its event is never seen,
  // either because it arrived between the check and the wait, or because it
  // was never sent. waitForEvent returns nothing here, exactly as it would.
  // The next slice's database read must still find the part.
  it('finds a part whose event was missed, on the next slice, not after 45 minutes', async () => {
    const { step, waits, readReceivedParts } = fakeStep(['daybook_xml', 'trialbalance_xml'], { explain_text: 3 });

    await waitForRequiredParts(step, { submissionId: 'sub-1', requiredParts: REQUIRED, readReceivedParts });

    expect(waits.length * WAIT_SLICE_MINUTES).toBeLessThan(WAIT_WINDOW_MINUTES);
  });

  it('gives up after exactly the slice budget and moves on when a part never comes', async () => {
    const { step, waits, calls, readReceivedParts } = fakeStep(['daybook_xml', 'trialbalance_xml']);

    await waitForRequiredParts(step, { submissionId: 'sub-1', requiredParts: REQUIRED, readReceivedParts });

    expect(waits).toHaveLength(WAIT_SLICES);
    expect(calls.filter((id) => id.startsWith('check-part-explain_text-'))).toHaveLength(WAIT_SLICES + 1);
  });

  it('gives every step a unique id, as Inngest requires', async () => {
    const { step, calls, readReceivedParts } = fakeStep([]);

    await waitForRequiredParts(step, { submissionId: 'sub-1', requiredParts: REQUIRED, readReceivedParts });

    expect(new Set(calls).size).toBe(calls.length);
  });

  it('waits for events for this submission and this part only, in short slices', async () => {
    const { step, waits, readReceivedParts } = fakeStep(['daybook_xml', 'trialbalance_xml'], { explain_text: 3 });

    await waitForRequiredParts(step, { submissionId: 'sub-9', requiredParts: REQUIRED, readReceivedParts });

    expect(waits[0]).toEqual({
      id: 'wait-for-explain_text-0',
      timeout: WAIT_SLICE_TIMEOUT,
      if: 'async.data.submissionId == "sub-9" && async.data.partType == "explain_text"',
    });
  });
});
