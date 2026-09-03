import { describe, expect, it } from 'vitest';
import { deriveBaseDifficultyLevel, describeRectification } from './advance-learner';

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
