import { describe, expect, it } from 'vitest';
import { deriveBaseDifficultyLevel, describeRectification, describeRectifications, submissionIdFromFailureEvent } from './advance-learner';

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

  // 2026-09-16: NEW used to read "failed again, same as last time", so a
  // learner's first scored batch was told a gap was still recurring.
  it('says nothing about history for a first-time failure', () => {
    expect(describeRectification({ conceptTag: 'gst_classification', classification: 'NEW', prior: null })).toBeNull();
    expect(
      describeRectifications([{ conceptTag: 'gst_classification', classification: 'NEW', prior: null }]),
    ).toEqual([]);
  });

  it('names the previous round of this batch for a correction round', () => {
    expect(
      describeRectification({ conceptTag: 'contra_voucher_basics', classification: 'STILL_FAILING', prior: 'previous-round' }),
    ).toBe('contra voucher basics was failing in the previous round of this batch and is still failing now');
  });

  it('names the last batch that tested the concept when the prior attempt was another exercise', () => {
    expect(
      describeRectification({ conceptTag: 'contra_voucher_basics', classification: 'STILL_FAILING', prior: 'earlier-batch' }),
    ).toBe('contra voucher basics was failing in the last batch that tested it and is still failing now');
    expect(describeRectification({ conceptTag: 'gst_classification', classification: 'FIXED', prior: 'earlier-batch' })).toBe(
      'GST classification was failing in the last batch that tested it and is fixed now',
    );
  });

  it('keeps the classification on each note so the grounding check knows which facts carry history', () => {
    expect(
      describeRectifications([
        { conceptTag: 'gst_classification', classification: 'FIXED', prior: 'previous-round' },
        { conceptTag: 'tds_classification', classification: 'NEW', prior: null },
        { conceptTag: 'contra_voucher_basics', classification: 'STILL_FAILING', prior: 'earlier-batch' },
      ]).map((note) => note.classification),
    ).toEqual(['FIXED', 'STILL_FAILING']);
  });
});
