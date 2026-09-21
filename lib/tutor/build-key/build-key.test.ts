import { describe, expect, it } from 'vitest';
import type { BatchPlan } from '@/lib/schemas/batch-plan';
import type { AnswerKeyEntry } from '@/lib/schemas/exercise';
import {
  checkConceptTagsMatchContent,
  checkGstArithmetic,
  checkGstHeadMetadata,
  checkTdsArithmetic,
  checkTdsThresholds,
  checkTextMatchesKey,
  transactionDateOf,
} from '@/lib/tutor/generation-checks';
import { checkCashFeasibility, checkDoubleEntry, checkSettlementReferences } from '@/lib/tutor/generate-exercise';
import { openBillsOf, replayKeys } from '@/lib/tutor/ledger-state';
import { buildPartyMaster } from '@/lib/tutor/party-master';
import { eventMenuFor } from './event-menu';
import { buildAnswerKey, type BuildKeyInput } from './index';

// Stage 3 of the rebuild (2026-09-22): the deterministic builder. Every
// built key is run through the legacy generator's own checks, which is the
// strongest statement available that the builder cannot author the error
// classes the audit found.

function leg(sequence: number, voucherType: string, account: string, drCr: 'Dr' | 'Cr', amount: number, extra: Partial<AnswerKeyEntry> = {}): AnswerKeyEntry {
  return {
    sequence,
    correct_account: account,
    dr_cr: drCr,
    amount,
    voucher_type: voucherType,
    gst_head: null,
    gst_rate: null,
    tds_section: null,
    tds_rate: null,
    tds_base: null,
    bill_reference: null,
    narration: null,
    concept_tags: ['sales_voucher_basics'],
    requires_source_document: false,
    source_document_type: null,
    ...extra,
  };
}

// The books entering June: an opening position, one open invoice, one
// open vendor bill, an unadjusted supplier advance, and an asset.
const prior = replayKeys([
  {
    opening_balances: [
      { account: 'HDFC Bank — 1234', dr_cr: 'Dr', amount: 900000 },
      { account: 'Cash', dr_cr: 'Dr', amount: 12000 },
      { account: 'Office Equipment', dr_cr: 'Dr', amount: 184000 },
      { account: 'Capital — Anita Rao', dr_cr: 'Cr', amount: 1096000 },
    ],
    entries: [
      leg(1, 'Sales', 'Karnataka Emporium', 'Dr', 47200, { bill_reference: 'INV-3000' }),
      leg(1, 'Sales', 'Sales', 'Cr', 40000, { bill_reference: 'INV-3000' }),
      leg(1, 'Sales', 'Output CGST', 'Cr', 3600, { bill_reference: 'INV-3000', gst_head: 'CGST', gst_rate: 9 }),
      leg(1, 'Sales', 'Output SGST', 'Cr', 3600, { bill_reference: 'INV-3000', gst_head: 'SGST', gst_rate: 9 }),
      leg(2, 'Purchase', 'Purchases', 'Dr', 30000, { bill_reference: 'MS/980' }),
      leg(2, 'Purchase', 'Input IGST', 'Dr', 5400, { bill_reference: 'MS/980', gst_head: 'IGST', gst_rate: 18 }),
      leg(2, 'Purchase', 'Mumbai Suppliers', 'Cr', 35400, { bill_reference: 'MS/980' }),
      leg(3, 'Payment', 'Bharat Machinery', 'Dr', 50000, { bill_reference: 'ADV-S01 (Advance)' }),
      leg(3, 'Payment', 'HDFC Bank — 1234', 'Cr', 50000, { bill_reference: 'ADV-S01 (Advance)' }),
    ],
  },
]);

const plan: BatchPlan = {
  scenario: 'Same company, continuing. Your invoices were strong, so this month works on advances and settlements.',
  difficulty_level: 'L3',
  events: [
    { type: 'sale', seq: 1, day: 2, customer: { name: 'Karnataka Emporium', new_party: false }, lines: [{ description: 'Cotton bed sheets', quantity: 100, rate: 500 }], gst_rate: 18, settlement: 'credit', adjust_advance_ref: null, doc_number: 'INV-3001' },
    { type: 'sale', seq: 2, day: 4, customer: { name: 'Ahmedabad Elite', new_party: false }, lines: [{ description: 'Curtains', quantity: 20, rate: 2500 }], gst_rate: 18, settlement: 'credit', adjust_advance_ref: null, doc_number: 'INV-3002' },
    { type: 'sale', seq: 3, day: 6, customer: { name: 'Cash', new_party: false }, lines: [{ description: 'Cushion covers', quantity: 10, rate: 1200 }], gst_rate: 18, settlement: 'cash', adjust_advance_ref: null, doc_number: 'CM-06' },
    { type: 'purchase', seq: 4, day: 7, vendor: { name: 'Deccan Traders', new_party: false }, nature: 'goods', ledger: null, lines: [{ description: 'Cotton fabric', quantity: 200, rate: 150 }], gst_rate: 18, settlement: 'credit', adjust_advance_ref: null, doc_number: 'DT/2027-06' },
    { type: 'purchase', seq: 5, day: 9, vendor: { name: 'Sharma Legal', new_party: false }, nature: 'service', ledger: 'Legal & Professional Charges', lines: [{ description: 'Retainer for June', quantity: 1, rate: 60000 }], gst_rate: 18, settlement: 'credit', adjust_advance_ref: null, doc_number: 'SL/2027-06' },
    { type: 'purchase', seq: 6, day: 11, vendor: { name: 'Bharat Machinery', new_party: false }, nature: 'asset', ledger: 'Office Equipment', lines: [{ description: 'Label printer', quantity: 1, rate: 85000 }], gst_rate: 18, settlement: 'adjust_advance', adjust_advance_ref: 'ADV-S01', doc_number: 'BM/2025-06' },
    { type: 'receipt', seq: 7, day: 13, customer: { name: 'Karnataka Emporium', new_party: false }, instrument: 'bank', settlement: { mode: 'full', bills: ['INV-3000', 'INV-3001'] } },
    { type: 'receipt', seq: 8, day: 15, customer: { name: 'Bengaluru Boutique', new_party: true }, instrument: 'bank', settlement: { mode: 'advance', amount: 45000 } },
    { type: 'payment', seq: 9, day: 18, payee: { name: 'Mumbai Suppliers', new_party: false }, settlement: { mode: 'part', bill: 'MS/980', amount: 20000 }, expense_ledger: null, amount: null, instrument: 'bank' },
    { type: 'payment', seq: 10, day: 20, payee: null, settlement: null, expense_ledger: 'Electricity Charges', amount: 6500, instrument: 'bank' },
    { type: 'contra', seq: 11, day: 24, direction: 'cash_to_bank', amount: 15000 },
    { type: 'depreciation', seq: 12, day: 30, asset_ledger: 'Office Equipment', months: 1, annual_rate_percent: 15 },
  ],
};

const input: BuildKeyInput = {
  plan,
  state: prior,
  master: buildPartyMaster(['Karnataka Emporium', 'Mumbai Suppliers', 'Bharat Machinery', 'Ahmedabad Elite', 'Deccan Traders', 'Sharma Legal']),
  menu: eventMenuFor('L3', ['supplier_advance', 'customer_advance', 'multi_bill_settlement', 'tds_classification', 'fixed_assets_depreciation'], false),
  month: { monthIndex: 5, year: 2025 },
  difficultyLevel: 'L3',
  licenseMode: 'licensed',
  bankAccount: 'HDFC Bank — 1234',
  usedDocumentNumbers: ['INV-3000', 'MS/980', 'ADV-S01'],
  tdsHistory: new Map(),
  documentsMode: false,
};

function legsOf(entries: AnswerKeyEntry[], sequence: number): AnswerKeyEntry[] {
  return entries.filter((entry) => entry.sequence === sequence);
}

describe('buildAnswerKey', () => {
  const result = buildAnswerKey(input);
  if (result.generated === null) throw new Error(result.violations.join('\n'));
  const generated = result.generated;
  const entries = generated.answer_key.entries;

  it('builds a balanced key that passes every legacy generation check', () => {
    expect(result.violations).toEqual([]);
    expect(checkDoubleEntry(generated)).toBeNull();
    expect(checkCashFeasibility(generated, { cash: 12000, bank: 850000 })).toBeNull();
    expect(checkSettlementReferences(generated, openBillsOf(prior))).toBeNull();
    const dateOf = transactionDateOf(generated);
    expect(checkGstArithmetic(generated, { dateOf })).toBeNull();
    expect(checkGstHeadMetadata(generated)).toBeNull();
    expect(checkTdsThresholds(generated, new Map(), { dateOf })).toBeNull();
    expect(checkTdsArithmetic(generated, { dateOf })).toBeNull();
    expect(checkTextMatchesKey(generated, openBillsOf(prior))).toBeNull();
    expect(checkConceptTagsMatchContent(generated)).toBeNull();
  });

  it('charges GST by the party state: Karnataka CGST+SGST, Gujarat IGST', () => {
    const karnataka = legsOf(entries, 1);
    expect(karnataka.map((item) => [item.correct_account, item.dr_cr, item.amount])).toEqual([
      ['Karnataka Emporium', 'Dr', 59000],
      ['Sales', 'Cr', 50000],
      ['Output CGST', 'Cr', 4500],
      ['Output SGST', 'Cr', 4500],
    ]);
    const gujarat = legsOf(entries, 2);
    expect(gujarat.map((item) => item.correct_account)).toEqual(['Ahmedabad Elite', 'Sales', 'Output IGST']);
    expect(gujarat[2].amount).toBe(9000);
    expect(gujarat[2].gst_rate).toBe(18);
  });

  it('numbers a cash sale but gives it no reference', () => {
    const cash = legsOf(entries, 3);
    expect(cash[0].correct_account).toBe('Cash');
    expect(cash.every((item) => item.bill_reference === null)).toBe(true);
  });

  it('deducts TDS on the legal bill above the FY 2025-26 threshold and credits the vendor net', () => {
    const legal = legsOf(entries, 5);
    const tds = legal.find((item) => /tds/i.test(item.correct_account));
    expect(tds).toMatchObject({ correct_account: 'TDS Payable — u/s 194J', dr_cr: 'Cr', amount: 6000, tds_section: '194J', tds_rate: 10, tds_base: 60000 });
    expect(legal.find((item) => item.correct_account === 'Sharma Legal')?.amount).toBe(64800);
  });

  it('adjusts the supplier advance on the asset bill and keeps the balance as a new bill', () => {
    const bharat = legsOf(entries, 6);
    expect(bharat.find((item) => item.correct_account === 'Bharat Machinery')?.bill_reference).toBe('ADV-S01 (Advance), BM/2025-06');
    expect(bharat.find((item) => item.correct_account === 'Office Equipment')?.amount).toBe(85000);
    expect(bharat.every((item) => item.concept_tags.includes('supplier_advance') && item.concept_tags.includes('fixed_assets_depreciation'))).toBe(true);
  });

  it('settles two bills in full for their exact balances, including one raised this batch', () => {
    const receipt = legsOf(entries, 7);
    expect(receipt[0]).toMatchObject({ correct_account: 'HDFC Bank — 1234', dr_cr: 'Dr', amount: 47200 + 59000 });
    expect(receipt[1].bill_reference).toBe('INV-3000 (Against Ref), INV-3001 (Against Ref)');
    expect(receipt[1].concept_tags).toContain('multi_bill_settlement');
  });

  it('mints the next customer advance reference and tags it', () => {
    const advance = legsOf(entries, 8);
    expect(advance[1].bill_reference).toBe('ADV-C01 (Advance)');
    expect(advance[1].concept_tags).toContain('customer_advance');
  });

  it('marks a part payment as such and leaves the bill open for the rest', () => {
    const part = legsOf(entries, 9);
    expect(part[0].bill_reference).toBe('MS/980 (Against Ref, part payment)');
    expect(part[0].amount).toBe(20000);
  });

  it("depreciates the asset ledger balance after the month's purchase", () => {
    const journal = legsOf(entries, 12);
    // (184,000 + 85,000) x 15% / 12
    expect(journal[0]).toMatchObject({ correct_account: 'Depreciation', dr_cr: 'Dr', amount: 3363 });
    expect(journal[1].correct_account).toBe('Office Equipment');
    expect(journal[0].concept_tags).toEqual(expect.arrayContaining(['journal_voucher_basics', 'fixed_assets_depreciation']));
  });

  it('writes every line from the key, with a date the checks can read, and pointers for document-backed lines', () => {
    expect(generated.transactions.map((transaction) => transaction.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(generated.transactions[3].description).toBe('On 07-Jun-2025, an invoice arrived from Deccan Traders (Ref DT/2027-06): post it from the attached invoice.');
    expect(generated.transactions[0].description).toContain('On 02-Jun-2025, you raised Sales Invoice INV-3001 on Karnataka Emporium');
    expect(generated.transactions[0].description).toContain('Rs 50,000');
    expect(generated.transactions[6].description).toBe('On 13-Jun-2025, a receipt from Karnataka Emporium against bill INV-3000, INV-3001 landed in the bank: post it from the bank statement.');
  });
});

describe('buildAnswerKey rejects what the books cannot support', () => {
  const rejected = (events: BatchPlan['events']) => buildAnswerKey({ ...input, plan: { ...plan, events }, menu: { ...input.menu, minEvents: 1 } });

  it('a settlement of a bill that is not open', () => {
    const result = rejected([{ type: 'receipt', seq: 1, day: 3, customer: { name: 'Karnataka Emporium', new_party: false }, instrument: 'bank', settlement: { mode: 'full', bills: ['KE/2026/018'] } }]);
    expect(result.generated).toBeNull();
    expect(result.violations[0]).toContain('no open bill KE/2026/018');
  });

  it('a reused document number', () => {
    const result = rejected([{ type: 'sale', seq: 1, day: 3, customer: { name: 'Karnataka Emporium', new_party: false }, lines: [{ description: 'x', quantity: 1, rate: 100 }], gst_rate: 18, settlement: 'credit', adjust_advance_ref: null, doc_number: 'INV-3000' }]);
    expect(result.violations[0]).toContain('already used');
  });

  it('cash going negative', () => {
    const result = rejected([{ type: 'contra', seq: 1, day: 3, direction: 'cash_to_bank', amount: 90000 }]);
    expect(result.violations[0]).toContain('cash can never go negative');
  });

  it('an advance the party does not hold, and a GST slab not in force', () => {
    const noAdvance = rejected([{ type: 'purchase', seq: 1, day: 3, vendor: { name: 'Deccan Traders', new_party: false }, nature: 'goods', ledger: null, lines: [{ description: 'x', quantity: 1, rate: 100000 }], gst_rate: 18, settlement: 'adjust_advance', adjust_advance_ref: 'ADV-S09', doc_number: 'DT/9' }]);
    expect(noAdvance.violations[0]).toContain('holds no open advance ADV-S09');
    const badRate = rejected([{ type: 'sale', seq: 1, day: 3, customer: { name: 'Karnataka Emporium', new_party: false }, lines: [{ description: 'x', quantity: 1, rate: 100 }], gst_rate: 10, settlement: 'credit', adjust_advance_ref: null, doc_number: 'INV-3009' }]);
    expect(badRate.violations[0]).toContain('not a slab in force');
  });
});
