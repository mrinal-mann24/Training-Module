import { describe, expect, it } from 'vitest';
import { combineOverallResult, groundingFromAnswerKey } from './score-qualitative';
import type { QualitativeScoring } from '@/lib/schemas/qualitative-scoring';
import type { AnswerKey } from '@/lib/schemas/exercise';

function makeQualitative(overrides: Partial<QualitativeScoring> = {}): QualitativeScoring {
  return { recall: 90, precision: 90, reasoning_quality: 90, rationale: 'test', ...overrides };
}

describe('combineOverallResult', () => {
  it('uses the quantitative result alone when there is no qualitative score (direct-entry exercises)', () => {
    expect(combineOverallResult('pass', null)).toBe('pass');
    expect(combineOverallResult('fail', null)).toBe('fail');
  });

  it('uses the qualitative result alone when there is no quantitative score (review exercises)', () => {
    expect(combineOverallResult(null, makeQualitative({ recall: 95, precision: 95, reasoning_quality: 95 }))).toBe(
      'pass',
    );
    expect(combineOverallResult(null, makeQualitative({ recall: 20, precision: 20, reasoning_quality: 20 }))).toBe(
      'fail',
    );
  });

  it('takes the worse of the two when both apply (explain exercises) — a clean posting cannot mask a weak explanation', () => {
    const weakQualitative = makeQualitative({ recall: 20, precision: 20, reasoning_quality: 20 });
    expect(combineOverallResult('pass', weakQualitative)).toBe('fail');
  });

  it('takes the worse of the two the other direction — a strong explanation cannot mask a failed posting', () => {
    const strongQualitative = makeQualitative({ recall: 95, precision: 95, reasoning_quality: 95 });
    expect(combineOverallResult('fail', strongQualitative)).toBe('fail');
  });

  it('throws if neither quantitative nor qualitative is provided', () => {
    expect(() => combineOverallResult(null, null)).toThrow();
  });
});

describe('groundingFromAnswerKey', () => {
  it('produces one grounding item per answer key entry, including GST/TDS/bill reference detail when present', () => {
    const answerKey: AnswerKey = {
      entries: [
        {
          sequence: 1,
          correct_account: 'IGST Payable',
          dr_cr: 'Dr',
          amount: 21150,
          voucher_type: 'Purchase',
          gst_head: 'IGST',
          gst_rate: 5,
          tds_section: null,
          tds_rate: null,
          tds_base: null,
          bill_reference: 'INV-001',
          narration: null,
          concept_tags: ['gst_classification'],
          requires_source_document: false,
          source_document_type: null,
        },
      ],
    };

    const grounding = groundingFromAnswerKey(answerKey);

    expect(grounding).toHaveLength(1);
    expect(grounding[0].label).toBe('Transaction 1');
    expect(grounding[0].detail).toContain('IGST @ 5%');
    expect(grounding[0].detail).toContain('bill reference: INV-001');
  });
});
