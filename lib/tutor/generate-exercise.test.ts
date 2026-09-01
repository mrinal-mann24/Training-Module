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

// --- planSourceDocuments (one combined bank statement, 2026-09-01) ---

import { planSourceDocuments } from './generate-exercise';
import type { SourceDocumentType } from '@/lib/schemas/source-document';

function docEntry(
  sequence: number,
  account: string,
  voucherType: string,
  docType: SourceDocumentType | null,
): GeneratedExercise['answer_key']['entries'][number] {
  return {
    ...entry(sequence, ['contra_voucher_basics'] as ConceptTag[]),
    correct_account: account,
    voucher_type: voucherType,
    requires_source_document: docType !== null,
    source_document_type: docType,
  };
}

function exerciseWith(entries: GeneratedExercise['answer_key']['entries']): GeneratedExercise {
  const sequences = [...new Set(entries.map((e) => e.sequence))];
  return {
    scenario: 'Batch: same company, continuing.',
    transactions: sequences.map((sequence) => ({
      sequence,
      description: `On 01-May-2026, transaction ${sequence}.`,
    })),
    difficulty_level: 'L1',
    variant: 'A',
    answer_key: { entries },
  };
}

describe('planSourceDocuments', () => {
  it('groups every bank-side transaction into ONE combined statement, invoices stay per bill', () => {
    // The live 2026-09-01 failure: 3 bank_statement transactions produced 3
    // separate "Bank Statement" PDFs. They must become 3 lines of one plan.
    const generated = exerciseWith([
      docEntry(1, 'HDFC Bank', 'Contra', 'bank_statement'),
      docEntry(2, 'Karnataka Emporium', 'Receipt', 'bank_statement'),
      docEntry(3, 'Sharma Legal', 'Payment', 'bank_statement'),
      docEntry(4, 'Signage Advertising', 'Purchase', 'vendor_invoice'),
      docEntry(5, 'Deccan Traders', 'Purchase', 'vendor_invoice'),
    ]);

    const plan = planSourceDocuments(generated);

    expect(plan.bankLines).toHaveLength(3);
    expect(plan.invoices).toHaveLength(2);
    expect(plan.bankLines.map((line) => line.entry.sequence)).toEqual([1, 2, 3]);
  });

  it('forces a bank-side voucher wrongly marked vendor_invoice into the statement', () => {
    // The live "Invoice — HDFC Bank.pdf" / "Invoice — TDS Payable.pdf" cards:
    // a Contra/Payment can never arrive as an invoice.
    const generated = exerciseWith([
      docEntry(1, 'HDFC Bank', 'Contra', 'vendor_invoice'),
      docEntry(2, 'TDS Payable', 'Payment', 'vendor_invoice'),
    ]);

    const plan = planSourceDocuments(generated);

    expect(plan.invoices).toHaveLength(0);
    expect(plan.bankLines).toHaveLength(2);
  });

  it('dedupes multi-leg transactions to one document per sequence', () => {
    const generated = exerciseWith([
      docEntry(1, 'Deccan Traders', 'Purchase', 'vendor_invoice'),
      docEntry(1, 'Purchases', 'Purchase', 'vendor_invoice'),
    ]);

    const plan = planSourceDocuments(generated);

    expect(plan.invoices).toHaveLength(1);
    expect(plan.invoices[0].partyAccounts).toEqual(['Deccan Traders', 'Purchases']);
  });

  it('carries the transaction description into the statement line for date grounding', () => {
    const generated = exerciseWith([docEntry(7, 'HDFC Bank', 'Receipt', 'bank_statement')]);

    const plan = planSourceDocuments(generated);

    expect(plan.bankLines[0].transactionDescription).toContain('transaction 7');
  });

  it('ignores unflagged transactions entirely', () => {
    const generated = exerciseWith([
      docEntry(1, 'HDFC Bank', 'Contra', null),
      docEntry(2, 'Cash', 'Receipt', null),
    ]);

    const plan = planSourceDocuments(generated);

    expect(plan.invoices).toHaveLength(0);
    expect(plan.bankLines).toHaveLength(0);
  });
});
