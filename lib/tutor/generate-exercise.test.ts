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

  it('dedupes multi-leg transactions to one document carrying the FULL leg set', () => {
    const generated = exerciseWith([
      docEntry(1, 'Deccan Traders', 'Purchase', 'vendor_invoice'),
      docEntry(1, 'Purchases', 'Purchase', 'vendor_invoice'),
    ]);

    const plan = planSourceDocuments(generated);

    expect(plan.invoices).toHaveLength(1);
    // The invoice generator needs every leg (base + tax + party) so the
    // PDF's figures can be pinned to the answer key exactly.
    expect(plan.invoices[0].legs.map((leg) => leg.correct_account)).toEqual([
      'Deccan Traders',
      'Purchases',
    ]);
    expect(plan.invoices[0].transactionDescription).toContain('transaction 1');
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

// --- cash/bank feasibility (2026-09-02, Garima's live report) ---

import { checkCashFeasibility } from './generate-exercise';

function cashBatch(
  items: { sequence: number; account: string; drCr: 'Dr' | 'Cr'; amount: number }[],
): GeneratedExercise {
  const sequences = [...new Set(items.map((i) => i.sequence))];
  return {
    scenario: 'Batch: same company, continuing.',
    transactions: sequences.map((sequence) => ({ sequence, description: `Transaction ${sequence}` })),
    difficulty_level: 'L1',
    variant: 'A',
    answer_key: {
      entries: items.map((i) => ({
        ...entry(i.sequence, ['contra_voucher_basics'] as ConceptTag[], 'Contra'),
        correct_account: i.account,
        dr_cr: i.drCr,
        amount: i.amount,
      })),
    },
  };
}

describe('checkCashFeasibility', () => {
  it('rejects the live failure: depositing more cash than the company holds', () => {
    // Garima's real position after the April pack was Cash 19,900; her
    // delivered batch opened with a 45,000 cash deposit, driving Cash to
    // -25,100 (her exact report: "i don't have sufficient cash to transfer
    // it to bank").
    const batch = cashBatch([
      { sequence: 1, account: 'HDFC Bank — 1234', drCr: 'Dr', amount: 45000 },
      { sequence: 1, account: 'Cash', drCr: 'Cr', amount: 45000 },
    ]);
    const error = checkCashFeasibility(batch, { cash: 19900, bank: 867186 });
    expect(error).toContain('Cash feasibility violated');
    expect(error).toContain('transaction 1');
  });

  it('accepts a deposit within the cash on hand', () => {
    const batch = cashBatch([
      { sequence: 1, account: 'HDFC Bank — 1234', drCr: 'Dr', amount: 15000 },
      { sequence: 1, account: 'Cash', drCr: 'Cr', amount: 15000 },
    ]);
    expect(checkCashFeasibility(batch, { cash: 19900, bank: 867186 })).toBeNull();
  });

  it('counts cash the batch itself brings in before a later deposit', () => {
    // Withdraw 40,000 from the bank first, then depositing 45,000 is fine.
    const batch = cashBatch([
      { sequence: 1, account: 'Cash', drCr: 'Dr', amount: 40000 },
      { sequence: 1, account: 'HDFC Bank — 1234', drCr: 'Cr', amount: 40000 },
      { sequence: 2, account: 'HDFC Bank — 1234', drCr: 'Dr', amount: 45000 },
      { sequence: 2, account: 'Cash', drCr: 'Cr', amount: 45000 },
    ]);
    expect(checkCashFeasibility(batch, { cash: 19900, bank: 867186 })).toBeNull();
  });

  it('rejects an order that overdraws cash even though the batch nets out', () => {
    // Same two transactions as above, but the deposit comes FIRST.
    const batch = cashBatch([
      { sequence: 1, account: 'HDFC Bank — 1234', drCr: 'Dr', amount: 45000 },
      { sequence: 1, account: 'Cash', drCr: 'Cr', amount: 45000 },
      { sequence: 2, account: 'Cash', drCr: 'Dr', amount: 40000 },
      { sequence: 2, account: 'HDFC Bank — 1234', drCr: 'Cr', amount: 40000 },
    ]);
    expect(checkCashFeasibility(batch, { cash: 19900, bank: 867186 })).toContain('transaction 1');
  });

  it('rejects a bank overdraft', () => {
    const batch = cashBatch([
      { sequence: 1, account: 'Cash', drCr: 'Dr', amount: 90000 },
      { sequence: 1, account: 'HDFC Bank — 1234', drCr: 'Cr', amount: 90000 },
    ]);
    const error = checkCashFeasibility(batch, { cash: 5000, bank: 50000 });
    expect(error).toContain('Bank feasibility violated');
  });

  it('ignores non-cash ledgers entirely', () => {
    const batch = cashBatch([
      { sequence: 1, account: 'Kochi Modern', drCr: 'Dr', amount: 500000 },
      { sequence: 1, account: 'Sales', drCr: 'Cr', amount: 500000 },
    ]);
    expect(checkCashFeasibility(batch, { cash: 100, bank: 100 })).toBeNull();
  });
});

// --- double-entry integrity (2026-09-02, Praveen's single-leg batch) ---

import { checkDoubleEntry } from './generate-exercise';

function legs(
  items: { seq: number; account: string; drCr: 'Dr' | 'Cr'; amount: number; gst?: 'CGST' | 'SGST' | 'IGST' | null; tds?: string | null }[],
): GeneratedExercise {
  const sequences = [...new Set(items.map((i) => i.seq))];
  return {
    scenario: 'Batch: same company, continuing.',
    transactions: sequences.map((sequence) => ({ sequence, description: `Transaction ${sequence}` })),
    difficulty_level: 'L1',
    variant: 'A',
    answer_key: {
      entries: items.map((i) => ({
        ...entry(i.seq, ['contra_voucher_basics'] as ConceptTag[], 'Contra'),
        correct_account: i.account,
        dr_cr: i.drCr,
        amount: i.amount,
        gst_head: i.gst ?? null,
        tds_section: i.tds ?? null,
      })),
    },
  };
}

describe('checkDoubleEntry', () => {
  it('rejects the live failure: single-leg transactions with no credit side', () => {
    // Praveen's delivered batch: 12/12 transactions carried only "Dr HDFC
    // Bank 90,000" with no matching credit, so the missing side was never
    // scored and the cash walk was blind to it.
    const batch = legs([
      { seq: 1, account: 'HDFC Bank — 1234', drCr: 'Dr', amount: 90000 },
      { seq: 2, account: 'Cash', drCr: 'Dr', amount: 25000 },
    ]);
    const error = checkDoubleEntry(batch);
    expect(error).toContain('Double-entry violated');
    expect(error).toContain('transaction(s) 1, 2 have only one side');
  });

  it('accepts a proper two-sided contra', () => {
    const batch = legs([
      { seq: 1, account: 'HDFC Bank — 1234', drCr: 'Dr', amount: 15000 },
      { seq: 1, account: 'Cash', drCr: 'Cr', amount: 15000 },
    ]);
    expect(checkDoubleEntry(batch)).toBeNull();
  });

  it('rejects a two-sided transaction whose totals do not balance', () => {
    const batch = legs([
      { seq: 1, account: 'HDFC Bank — 1234', drCr: 'Dr', amount: 15000 },
      { seq: 1, account: 'Cash', drCr: 'Cr', amount: 12000 },
    ]);
    expect(checkDoubleEntry(batch)).toContain('Dr 15000 vs Cr 12000');
  });

  it('tolerates the documented GST-as-metadata imbalance', () => {
    // A taxed sale legitimately shows Dr 118,000 against Cr 100,000 because
    // the 18,000 GST rides as gst_head metadata, not as a ledger leg — the
    // same design score-submission.ts exempts from tie-out.
    const batch = legs([
      { seq: 1, account: 'Kochi Modern', drCr: 'Dr', amount: 118000, gst: 'IGST' },
      { seq: 1, account: 'Sales', drCr: 'Cr', amount: 100000, gst: 'IGST' },
    ]);
    expect(checkDoubleEntry(batch)).toBeNull();
  });

  it('still balances a transaction that carries EXPLICIT tax legs', () => {
    // When GST is posted as real legs, the transaction must balance exactly.
    const batch = legs([
      { seq: 1, account: 'Kochi Modern', drCr: 'Dr', amount: 118000, gst: 'IGST' },
      { seq: 1, account: 'Sales', drCr: 'Cr', amount: 100000, gst: 'IGST' },
      { seq: 1, account: 'Output IGST', drCr: 'Cr', amount: 18000, gst: 'IGST' },
    ]);
    expect(checkDoubleEntry(batch)).toBeNull();

    const broken = legs([
      { seq: 1, account: 'Kochi Modern', drCr: 'Dr', amount: 118000, gst: 'IGST' },
      { seq: 1, account: 'Sales', drCr: 'Cr', amount: 100000, gst: 'IGST' },
      { seq: 1, account: 'Output IGST', drCr: 'Cr', amount: 9000, gst: 'IGST' },
    ]);
    expect(checkDoubleEntry(broken)).toContain('do not balance');
  });
});

describe('checkCashFeasibility with an overdrawn till (2026-09-02, live learners)', () => {
  // Both live learners posted an impossible deposit from an earlier batch, so
  // their next batch opens with negative cash and MUST replenish first.
  const overdrawn = { cash: -70100, bank: 900000 };

  it('rejects a batch that does not replenish the till first', () => {
    const batch = cashBatch([
      { sequence: 1, account: 'Kochi Modern', drCr: 'Dr', amount: 100000 },
      { sequence: 1, account: 'Sales', drCr: 'Cr', amount: 100000 },
    ]);
    const error = checkCashFeasibility(batch, overdrawn);
    expect(error).toContain('opens this batch overdrawn');
    expect(error).toContain('at least 70100');
  });

  it('accepts a batch whose first transaction clears the shortfall', () => {
    const batch = cashBatch([
      { sequence: 1, account: 'Cash', drCr: 'Dr', amount: 80000 },
      { sequence: 1, account: 'HDFC Bank — 1234', drCr: 'Cr', amount: 80000 },
      { sequence: 2, account: 'HDFC Bank — 1234', drCr: 'Dr', amount: 5000 },
      { sequence: 2, account: 'Cash', drCr: 'Cr', amount: 5000 },
    ]);
    expect(checkCashFeasibility(batch, overdrawn)).toBeNull();
  });
});

import { stripDuplicateTransactionList } from './generate-exercise';

describe('stripDuplicateTransactionList (Praveen Level 3 saw the 12 items twice, 2026-09-02)', () => {
  const transactions = [
    { sequence: 1, description: 'On 01-Jun-2026, withdraw Rs 50,000 from HDFC Bank — 1234 to Cash-in-Hand, to clear the overdrawn till and set a working float for the month.' },
    { sequence: 2, description: 'On 02-Jun-2026, sell furnishings to Kolkata Emporium (West Bengal) on credit under Invoice INV-2201: base value Rs 78,000 plus IGST @18% Rs 14,040, total Rs 92,040.' },
  ];
  const base = {
    scenario: '',
    transactions,
    answer_key: { entries: [] },
    difficulty_level: 'L1',
    variant: 'A',
  } as unknown as GeneratedExercise;

  it('removes numbered lines that restate the structured transactions, keeping the prose', () => {
    const scenario = [
      'Batch: same company, continuing. The till needs fixing first.',
      '',
      '1. On 01-Jun-2026, withdraw Rs 50,000 from HDFC Bank — 1234 to Cash-in-Hand, to clear the overdrawn till and set a working float for the month.',
      '2. On 02-Jun-2026, sell furnishings to Kolkata Emporium (West Bengal) on credit under Invoice INV-2201: base value Rs 78,000 plus IGST @18% Rs 14,040, total Rs 92,040.',
      '',
      'Post all twelve into Blossom Retail Pvt Ltd, then export ONE Tally Day Book plus the Trial Balance.',
    ].join('\n');
    const result = stripDuplicateTransactionList({ ...base, scenario });
    expect(result.scenario).toBe(
      'Batch: same company, continuing. The till needs fixing first.\n\nPost all twelve into Blossom Retail Pvt Ltd, then export ONE Tally Day Book plus the Trial Balance.',
    );
    expect(result.transactions).toBe(transactions);
  });

  it('leaves a scenario without an inline list untouched (Garima Level 3)', () => {
    const scenario = 'Batch: same company, continuing. Your sales vouchers have been strong. Deliverables: post everything below.';
    const input = { ...base, scenario };
    expect(stripDuplicateTransactionList(input)).toBe(input);
  });

  it('keeps numbered lines that are not transactions', () => {
    const scenario = 'Two reminders:\n1. Export the Day Book in XML.\n2. Narrations carry the bank reference verbatim.';
    expect(stripDuplicateTransactionList({ ...base, scenario }).scenario).toBe(scenario);
  });
});

import { checkOpeningFigures, scrubOpeningFigureSentences, stampOpeningPosition } from './generate-exercise';

describe('opening figures in the scenario prose (Yeshas Level 2 said 8,67,186 for an 8,66,116 bank balance, 2026-09-02)', () => {
  const position = { cash: 19900, bank: 866116 };
  const base = {
    scenario: '',
    transactions: [],
    answer_key: { entries: [] },
    difficulty_level: 'L1',
    variant: 'A',
  } as unknown as GeneratedExercise;

  it('flags a mistyped opening figure for retry', () => {
    const error = checkOpeningFigures(
      { ...base, scenario: 'Batch: same company. Opening this batch you are holding Rs 19,900 in Cash-in-Hand and Rs 8,67,186 in HDFC Bank - 1234.' },
      position,
    );
    expect(error).toContain('Rs 8,67,186');
    expect(error).toContain('Rs 8,66,116');
  });

  it('accepts the true figures and prose with no figures at all', () => {
    expect(checkOpeningFigures({ ...base, scenario: 'You hold Rs 19,900 in Cash-in-Hand and Rs 8,66,116 in the bank.' }, position)).toBeNull();
    expect(checkOpeningFigures({ ...base, scenario: 'Batch: same company, continuing. The till is overdrawn, so fix it first.' }, position)).toBeNull();
  });

  it('accepts the overdrawn amount as a figure when cash is negative', () => {
    expect(checkOpeningFigures({ ...base, scenario: 'The till is sitting at minus Rs 55,100, so fix it first.' }, { cash: -55100, bank: 951116 })).toBeNull();
  });

  it('scrubs a surviving wrong-figure sentence and stamps the true position', () => {
    const scrubbed = scrubOpeningFigureSentences(
      { ...base, scenario: 'Batch: same company, continuing. Opening this batch you hold Rs 8,67,186 in HDFC Bank - 1234. Work in date order.' },
      position,
    );
    expect(scrubbed.scenario).toBe('Batch: same company, continuing. Work in date order.');
    const stamped = stampOpeningPosition(scrubbed, position, [{ account: 'HDFC Bank — 1234' }, { account: 'Cash' }]);
    expect(stamped.scenario).toBe(
      'Batch: same company, continuing. Work in date order.\n\nOpening position for this batch (system-computed from your books): Cash-in-Hand Rs 19,900; HDFC Bank — 1234 Rs 8,66,116.',
    );
  });

  it('marks an overdrawn till in the stamped line', () => {
    const stamped = stampOpeningPosition(base, { cash: -20100, bank: 926116 }, [{ account: 'HDFC Bank — 1234' }]);
    expect(stamped.scenario).toContain('Cash-in-Hand Rs 20,100 (overdrawn)');
  });
});

import { checkSettlementReferences } from './generate-exercise';

describe('checkSettlementReferences (invented bill numbers: DT-2216, BR/S/098, CS/612 — 2026-09-03)', () => {
  const openBills = [
    { party: 'Deccan Traders', ref: 'DT/334', open: 69620, side: 'payable' as const },
    { party: 'Delhi Bazaar', ref: 'INV-003', open: 22000, side: 'receivable' as const },
  ];
  const settlement = (party: string, amount: number, ref: string, description: string, extra: GeneratedExercise['answer_key']['entries'] = []) =>
    ({
      scenario: '',
      transactions: [{ sequence: 1, description }],
      difficulty_level: 'L1',
      variant: 'A',
      answer_key: {
        entries: [
          { ...entry(1, ['payment_voucher_basics'], 'Payment'), correct_account: party, dr_cr: 'Dr', amount, bill_reference: ref },
          { ...entry(1, ['payment_voucher_basics'], 'Payment'), correct_account: 'HDFC Bank — 1234', dr_cr: 'Cr', amount, bill_reference: ref },
          ...extra,
        ],
      },
    }) as unknown as GeneratedExercise;

  it('rejects a settlement against a bill that does not exist and lists the real ones', () => {
    const error = checkSettlementReferences(settlement('Deccan Traders', 42500, 'DT-2216', 'pays Deccan Traders Rs 42,500 in full settlement of DT-2216'), openBills);
    expect(error).toContain('DT-2216');
    expect(error).toContain('DT/334');
  });

  it('rejects a "full settlement" that does not match the outstanding balance', () => {
    const error = checkSettlementReferences(settlement('Deccan Traders', 42500, 'DT/334', 'pays Deccan Traders Rs 42,500 in full settlement of DT/334'), openBills);
    expect(error).toContain('full settlement');
  });

  it('accepts a part payment within the balance and an exact full settlement', () => {
    expect(checkSettlementReferences(settlement('Deccan Traders', 42500, 'DT/334', 'part payment against DT/334'), openBills)).toBeNull();
    expect(checkSettlementReferences(settlement('Deccan Traders', 69620, 'Against DT/334 (full)', 'full settlement of DT/334'), openBills)).toBeNull();
  });

  it('accepts settling a bill raised earlier in the same batch', () => {
    const raised = [
      { ...entry(2, ['purchase_voucher_basics'], 'Purchase'), correct_account: 'Vizag Vendors', dr_cr: 'Cr', amount: 17700, bill_reference: 'VV-556' },
      { ...entry(2, ['purchase_voucher_basics'], 'Purchase'), correct_account: 'Purchases', dr_cr: 'Dr', amount: 17700, bill_reference: 'VV-556' },
    ] as GeneratedExercise['answer_key']['entries'];
    expect(checkSettlementReferences(settlement('Vizag Vendors', 17700, 'VV-556', 'full settlement of VV-556', raised), openBills)).toBeNull();
  });

  it('ignores receipts/payments with no bill reference (advances, expenses)', () => {
    expect(checkSettlementReferences(settlement('Rent', 28000, null as unknown as string, 'pays office rent'), openBills)).toBeNull();
  });
});
