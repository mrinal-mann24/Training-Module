import { describe, expect, it } from 'vitest';
import { deriveBaseDifficultyLevel, describeRectification, submissionIdFromFailureEvent } from './advance-learner';

describe('submissionIdFromFailureEvent', () => {
  // inngest/function.failed carries the ORIGINAL event one level down, at
  // event.data.event (FailureEventPayload in SDK 4.18).
  it('reads the submission id from the original triggering event', () => {
    const failure = {
      name: 'inngest/function.failed',
      data: { function_id: 'ai-tutor-run-scoring', run_id: 'r1', error: {}, event: { data: { submissionId: 'sub-1' } } },
    };
    expect(submissionIdFromFailureEvent(failure)).toBe('sub-1');
  });

  // A failure handler that throws would leave the submission stuck, the very
  // thing it exists to prevent, so a bad shape yields null.
  it.each([null, undefined, {}, { data: {} }, { data: { event: {} } }, { data: { event: { data: { submissionId: '' } } } }, { data: { event: { data: { submissionId: 42 } } } }])(
    'returns null instead of throwing on an unexpected shape: %j',
    (failure) => {
      expect(submissionIdFromFailureEvent(failure)).toBeNull();
    },
  );
});

describe('advance-learner helpers (shared by both scoring jobs)', () => {
  it('steps difficulty up one level and caps at the top', () => {
    expect(deriveBaseDifficultyLevel('L1')).toBe('L2');
    expect(deriveBaseDifficultyLevel('L3')).toBe('L4');
    expect(deriveBaseDifficultyLevel('L4')).toBe('L4');
  });

  it('phrases rectifications in plain language', () => {
    expect(describeRectification({ conceptTag: 'gst_classification', classification: 'FIXED' })).toBe(
      'gst classification was failing before and is now fixed',
    );
    expect(describeRectification({ conceptTag: 'contra_voucher_basics', classification: 'STILL_FAILING' })).toBe(
      'contra voucher basics failed again, same as last time: still failing',
    );
  });
});
