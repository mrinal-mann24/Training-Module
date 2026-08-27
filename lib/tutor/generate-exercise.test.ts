import { describe, expect, it } from 'vitest';
import { checkBatchComposition } from './generate-exercise';
import type { ConceptTag, GeneratedExercise } from '@/lib/schemas/exercise';

function entry(sequence: number, conceptTags: ConceptTag[]) {
  return {
    sequence,
    correct_account: 'Some Account',
    dr_cr: 'Dr' as const,
    amount: 1000,
    voucher_type: 'Contra',
    gst_head: null,
    gst_rate: null,
    tds_section: null,
    tds_rate: null,
    tds_base: null,
    bill_reference: null,
    narration: null,
    concept_tags: conceptTags,
    requires_source_document: false,
    source_document_type: null,
  };
}

function batch(tagsPerTransaction: ConceptTag[][]): GeneratedExercise {
  return {
    scenario: 'Batch: same company, continuing.',
    transactions: tagsPerTransaction.map((_, index) => ({
      sequence: index + 1,
      description: `Transaction ${index + 1}`,
    })),
    difficulty_level: 'L1',
    variant: 'A',
    answer_key: {
      entries: tagsPerTransaction.map((tags, index) => entry(index + 1, tags)),
    },
  };
}

const plan = {
  strengths: ['sales_voucher_basics', 'tds_classification'] as ConceptTag[],
  weaknesses: ['contra_voucher_basics'] as ConceptTag[],
};

describe('checkBatchComposition (Phase 2 live-fix)', () => {
  it('rejects the observed live failure: 10 transactions all on one concept', () => {
    const allContra = batch(Array.from({ length: 10 }, () => ['contra_voucher_basics' as ConceptTag]));
    const error = checkBatchComposition(allContra, plan, false);
    expect(error).toContain('Batch composition violated');
    expect(error).toContain('0 transactions carry a strength concept');
  });

  it('accepts a genuinely split batch', () => {
    const split = batch([
      ['sales_voucher_basics'], ['sales_voucher_basics'], ['tds_classification'], ['tds_classification'],
      ['contra_voucher_basics'], ['contra_voucher_basics'], ['contra_voucher_basics'], ['contra_voucher_basics'],
      ['sales_voucher_basics'], ['contra_voucher_basics'],
    ] as ConceptTag[][]);
    expect(checkBatchComposition(split, plan, false)).toBe(null);
  });

  it('rejects a batch below 10 transactions', () => {
    const short = batch(Array.from({ length: 6 }, () => ['contra_voucher_basics' as ConceptTag]));
    expect(checkBatchComposition(short, plan, false)).toContain('6 transactions');
  });

  it('skips the check entirely under escalation', () => {
    const tiny = batch(Array.from({ length: 3 }, () => ['contra_voucher_basics' as ConceptTag]));
    expect(checkBatchComposition(tiny, plan, true)).toBe(null);
  });

  it('allows a one-sided batch when the learner has no strengths yet, but still enforces the count', () => {
    const noStrengths = { strengths: [] as ConceptTag[], weaknesses: ['contra_voucher_basics'] as ConceptTag[] };
    const tenOneSided = batch(Array.from({ length: 10 }, () => ['contra_voucher_basics' as ConceptTag]));
    expect(checkBatchComposition(tenOneSided, noStrengths, false)).toBe(null);
    const fiveOneSided = batch(Array.from({ length: 5 }, () => ['contra_voucher_basics' as ConceptTag]));
    expect(checkBatchComposition(fiveOneSided, noStrengths, false)).toContain('5 transactions');
  });

  it('a multi-concept transaction counts toward both sides', () => {
    const overlapping = batch([
      ['sales_voucher_basics', 'contra_voucher_basics'], ['sales_voucher_basics', 'contra_voucher_basics'],
      ['sales_voucher_basics', 'contra_voucher_basics'], ['sales_voucher_basics', 'contra_voucher_basics'],
      ['contra_voucher_basics'], ['contra_voucher_basics'], ['contra_voucher_basics'],
      ['contra_voucher_basics'], ['contra_voucher_basics'], ['contra_voucher_basics'],
    ] as ConceptTag[][]);
    expect(checkBatchComposition(overlapping, plan, false)).toBe(null);
  });
});
