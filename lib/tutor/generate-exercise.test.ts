import { describe, expect, it } from 'vitest';
import { checkBatchComposition } from './generate-exercise';
import type { ConceptTag, GeneratedExercise } from '@/lib/schemas/exercise';

function entry(sequence: number, conceptTags: ConceptTag[], voucherType = 'Contra') {
  return {
    sequence,
    correct_account: 'Some Account',
    dr_cr: 'Dr' as const,
    amount: 1000,
    voucher_type: voucherType,
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

// voucherTypes aligns by index with tagsPerTransaction; unspecified
// transactions default to Contra (the pure-bank shape the trading-mix rule
// exists to reject).
function batch(tagsPerTransaction: ConceptTag[][], voucherTypes: string[] = []): GeneratedExercise {
  return {
    scenario: 'Batch: same company, continuing.',
    transactions: tagsPerTransaction.map((_, index) => ({
      sequence: index + 1,
      description: `Transaction ${index + 1}`,
    })),
    difficulty_level: 'L1',
    variant: 'A',
    answer_key: {
      entries: tagsPerTransaction.map((tags, index) => entry(index + 1, tags, voucherTypes[index] ?? 'Contra')),
    },
  };
}

// A voucher-type spread satisfying the trading-mix floor (2 Sales + 2
// Purchases) for 10-transaction batches whose tests target the CONCEPT rules.
const TRADING_MIX_TYPES = ['Sales', 'Sales', 'Purchase', 'Purchase', 'Contra', 'Contra', 'Receipt', 'Payment', 'Contra', 'Contra'];

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

  it('accepts a genuinely split batch with trading activity', () => {
    const split = batch([
      ['sales_voucher_basics'], ['sales_voucher_basics'], ['tds_classification'], ['tds_classification'],
      ['contra_voucher_basics'], ['contra_voucher_basics'], ['contra_voucher_basics'], ['contra_voucher_basics'],
      ['sales_voucher_basics'], ['contra_voucher_basics'],
    ] as ConceptTag[][], TRADING_MIX_TYPES);
    expect(checkBatchComposition(split, plan, false)).toBe(null);
  });

  it('rejects a pure bank-movement batch even when the concept split is satisfied (trading mix, 2026-09-01)', () => {
    // The observed live Module-2 batch: concept counts fine, but every
    // transaction was a contra/receipt/payment — zero trading activity.
    const bankOnly = batch([
      ['sales_voucher_basics'], ['sales_voucher_basics'], ['tds_classification'], ['tds_classification'],
      ['contra_voucher_basics'], ['contra_voucher_basics'], ['contra_voucher_basics'], ['contra_voucher_basics'],
      ['sales_voucher_basics'], ['contra_voucher_basics'],
    ] as ConceptTag[][], ['Contra', 'Receipt', 'Payment', 'Contra', 'Contra', 'Receipt', 'Payment', 'Contra', 'Receipt', 'Payment']);
    const error = checkBatchComposition(bankOnly, plan, false);
    expect(error).toContain('Trading-mix violated');
    expect(error).toContain('0 Sales and 0 Purchase');
  });

  it('rejects a batch with sales but too few purchases', () => {
    const oneSided = batch(
      Array.from({ length: 10 }, () => ['sales_voucher_basics'] as ConceptTag[]).map((tags, i) =>
        i < 4 ? tags : (['contra_voucher_basics'] as ConceptTag[]),
      ),
      ['Sales', 'Sales', 'Sales', 'Purchase', 'Contra', 'Contra', 'Contra', 'Contra', 'Contra', 'Contra'],
    );
    expect(checkBatchComposition(oneSided, plan, false)).toContain('3 Sales and 1 Purchase');
  });

  it('reports the trading-mix and concept violations together in one message', () => {
    // Both broken at once must surface in one retry message, not burn the
    // bounded retry budget one rule at a time.
    const allContra = batch(Array.from({ length: 10 }, () => ['contra_voucher_basics' as ConceptTag]));
    const error = checkBatchComposition(allContra, plan, false);
    expect(error).toContain('Trading-mix violated');
    expect(error).toContain('Batch composition violated');
  });

  it('rejects a batch below 10 transactions', () => {
    const short = batch(Array.from({ length: 6 }, () => ['contra_voucher_basics' as ConceptTag]));
    expect(checkBatchComposition(short, plan, false)).toContain('6 transactions');
  });

  it('skips the check entirely under escalation', () => {
    const tiny = batch(Array.from({ length: 3 }, () => ['contra_voucher_basics' as ConceptTag]));
    expect(checkBatchComposition(tiny, plan, true)).toBe(null);
  });

  it('allows a one-sided batch when the learner has no strengths yet, but still enforces count and trading mix', () => {
    const noStrengths = { strengths: [] as ConceptTag[], weaknesses: ['contra_voucher_basics'] as ConceptTag[] };
    const tenOneSided = batch(
      Array.from({ length: 10 }, () => ['contra_voucher_basics' as ConceptTag]),
      TRADING_MIX_TYPES,
    );
    expect(checkBatchComposition(tenOneSided, noStrengths, false)).toBe(null);
    const fiveOneSided = batch(Array.from({ length: 5 }, () => ['contra_voucher_basics' as ConceptTag]));
    expect(checkBatchComposition(fiveOneSided, noStrengths, false)).toContain('5 transactions');
    // Trading mix applies even before any strengths exist — a trading month
    // needs trading activity regardless of the concept plan.
    const tenAllContra = batch(Array.from({ length: 10 }, () => ['contra_voucher_basics' as ConceptTag]));
    expect(checkBatchComposition(tenAllContra, noStrengths, false)).toContain('Trading-mix violated');
  });

  it('a multi-concept transaction counts toward both sides', () => {
    const overlapping = batch([
      ['sales_voucher_basics', 'contra_voucher_basics'], ['sales_voucher_basics', 'contra_voucher_basics'],
      ['sales_voucher_basics', 'contra_voucher_basics'], ['sales_voucher_basics', 'contra_voucher_basics'],
      ['contra_voucher_basics'], ['contra_voucher_basics'], ['contra_voucher_basics'],
      ['contra_voucher_basics'], ['contra_voucher_basics'], ['contra_voucher_basics'],
    ] as ConceptTag[][], TRADING_MIX_TYPES);
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

// --- month-per-batch progression (2026-09-01) ---

import { checkBatchMonth, exerciseMonthForModule } from './generate-exercise';

function datedBatch(descriptions: string[]): GeneratedExercise {
  return {
    scenario: 'Batch: same company, continuing.',
    transactions: descriptions.map((description, index) => ({ sequence: index + 1, description })),
    difficulty_level: 'L1',
    variant: 'A',
    answer_key: { entries: descriptions.map((_, index) => entry(index + 1, ['contra_voucher_basics'] as ConceptTag[])) },
  };
}

describe('exerciseMonthForModule', () => {
  it('anchors ordinal 1 on the diagnostic pack month, April 2026', () => {
    expect(exerciseMonthForModule(1)).toEqual({ label: 'April 2026', monthIndex: 3, year: 2026 });
  });

  it('advances one calendar month per exercise', () => {
    expect(exerciseMonthForModule(2).label).toBe('May 2026');
    expect(exerciseMonthForModule(3).label).toBe('June 2026');
    expect(exerciseMonthForModule(5).label).toBe('August 2026');
  });

  it('rolls over the year boundary', () => {
    expect(exerciseMonthForModule(10).label).toBe('January 2027');
    expect(exerciseMonthForModule(13).label).toBe('April 2027');
  });
});

describe('checkBatchMonth', () => {
  const may = exerciseMonthForModule(2);

  it('accepts a batch dated entirely inside the assigned month', () => {
    const batch = datedBatch([
      'On 01-May-2026, transferred Rs. 15,000 from Cash to HDFC Bank.',
      'On 15/05/2026, sold goods to Karnataka Emporium for Rs. 30,000 plus GST.',
    ]);
    expect(checkBatchMonth(batch, may)).toBe(null);
  });

  it('rejects the observed live failure: May and June mixed in one batch', () => {
    const batch = datedBatch([
      'On 01-May-2026, transferred Rs. 15,000 from Cash to HDFC Bank.',
      'On 01-Jun-2026, settled Rs. 6,000 to Sharma Legal.',
    ]);
    const error = checkBatchMonth(batch, may);
    expect(error).toContain('Month violated');
    expect(error).toContain('01-Jun-2026');
  });

  it('rejects a wrong-year date', () => {
    const batch = datedBatch(['On 01-May-2025, received Rs. 10,000 from Delhi Bazaar.']);
    expect(checkBatchMonth(batch, may)).toContain('01-May-2025');
  });

  it('does not treat a bare month mention as a transaction date', () => {
    const batch = datedBatch([
      'On 02-May-2026, received Rs. 75,000 from Karnataka Emporium settling the March invoice.',
    ]);
    expect(checkBatchMonth(batch, may)).toBe(null);
  });

  it('leaves descriptions with no parseable date to the prompt', () => {
    const batch = datedBatch(['Early in the month, paid Rs. 350 in bank charges.']);
    expect(checkBatchMonth(batch, may)).toBe(null);
  });
});

// --- document-backed transactions are pointers, not spelled-out entries (2026-09-01) ---

import { checkDocumentBackedDescriptions } from './generate-exercise';

function docBackedBatch(
  items: { description: string; docType: SourceDocumentType | null }[],
): GeneratedExercise {
  return {
    scenario: 'Batch: same company, continuing.',
    transactions: items.map((item, index) => ({ sequence: index + 1, description: item.description })),
    difficulty_level: 'L1',
    variant: 'A',
    answer_key: {
      entries: items.map((item, index) => ({
        ...entry(index + 1, ['purchase_voucher_basics'] as ConceptTag[], 'Purchase'),
        requires_source_document: item.docType !== null,
        source_document_type: item.docType,
      })),
    },
  };
}

describe('checkDocumentBackedDescriptions', () => {
  it('rejects a doc-backed transaction whose text states the amount (the live failure)', () => {
    const generated = docBackedBatch([
      { description: 'On 05-May-2026, purchase office supplies from Deccan Traders for ₹12,000.00 + GST (6%). Invoice #DT2026.', docType: 'vendor_invoice' },
    ]);
    const error = checkDocumentBackedDescriptions(generated);
    expect(error).toContain('Document-backed text violated');
    expect(error).toContain('1');
  });

  it('rejects a doc-backed transaction stating an Rs. amount', () => {
    const generated = docBackedBatch([
      { description: 'On 06-May-2026, paid Rs. 8,000 to Signage Advertising from HDFC Bank.', docType: 'bank_statement' },
    ]);
    expect(checkDocumentBackedDescriptions(generated)).toContain('Document-backed text violated');
  });

  it('accepts a proper pointer line with date and party but no figures', () => {
    const generated = docBackedBatch([
      { description: 'On 05-May-2026, an invoice arrived from Deccan Traders for office supplies: post it from the attached invoice.', docType: 'vendor_invoice' },
    ]);
    expect(checkDocumentBackedDescriptions(generated)).toBe(null);
  });

  it('leaves undocumented transactions free to state full figures', () => {
    const generated = docBackedBatch([
      { description: 'On 07-May-2026, sold goods to Karnataka Emporium for Rs. 30,000 plus CGST and SGST at 9% each.', docType: null },
    ]);
    expect(checkDocumentBackedDescriptions(generated)).toBe(null);
  });

  it('does not treat dates or account/invoice identifiers as figure leaks', () => {
    const generated = docBackedBatch([
      { description: 'On 12-May-2026, a receipt from Delhi Bazaar landed in HDFC Bank — 1234: post it from the bank statement, invoice DB2026.', docType: 'bank_statement' },
    ]);
    expect(checkDocumentBackedDescriptions(generated)).toBe(null);
  });
});
