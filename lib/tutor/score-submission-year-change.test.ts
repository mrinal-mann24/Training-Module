import { describe, expect, it } from 'vitest';
import type { AnswerKey, AnswerKeyEntry } from '@/lib/schemas/exercise';
import type { ParsedTrialBalance } from '@/lib/schemas/voucher';
import { evaluateTrialBalanceTieOut } from './score-submission';

// 2026-09-11: the first batch of a financial year. Tally restarts the
// profit-and-loss ledgers on 1 April, so an April export shows Sales as
// April's sales only while the March baseline carries the whole previous
// year (Garima's April: "Sales off by Rs 32,11,000", her 2024-25 total).
// Balance-sheet ledgers carry on. A learner who exports the whole period
// since books began instead (cumulative Sales) must tie out too.

function leg(sequence: number, account: string, side: 'Dr' | 'Cr', amount: number, overrides: Partial<AnswerKeyEntry> = {}): AnswerKeyEntry {
  return {
    sequence,
    correct_account: account,
    dr_cr: side,
    amount,
    voucher_type: 'Sales',
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
    ...overrides,
  };
}

function trialBalance(rows: [name: string, signed: number][]): ParsedTrialBalance {
  return {
    ledgers: rows.map(([ledgerName, signed]) => ({
      ledgerName,
      closingDebit: signed > 0 ? signed : 0,
      closingCredit: signed < 0 ? -signed : 0,
    })),
  } as ParsedTrialBalance;
}

// April 2025: one sale of 23,600 (20,000 + GST) and rent paid 10,000.
const aprilKey: AnswerKey = {
  entries: [
    leg(1, 'Karnataka Emporium', 'Dr', 23600, { bill_reference: 'INV-070' }),
    leg(1, 'Sales', 'Cr', 20000),
    leg(1, 'Output CGST', 'Cr', 1800, { gst_head: 'CGST', gst_rate: 9 }),
    leg(1, 'Output SGST', 'Cr', 1800, { gst_head: 'SGST', gst_rate: 9 }),
    leg(2, 'Rent', 'Dr', 10000, { voucher_type: 'Payment' }),
    leg(2, 'HDFC Bank — 1234', 'Cr', 10000, { voucher_type: 'Payment' }),
    // Generated keys stamp the bill reference on every leg, the Purchases
    // leg included: that must not make Purchases a party ledger.
    leg(3, 'Purchases', 'Dr', 50000, { voucher_type: 'Purchase', bill_reference: 'MS-900' }),
    leg(3, 'Input CGST', 'Dr', 4500, { voucher_type: 'Purchase', gst_head: 'CGST', gst_rate: 9, bill_reference: 'MS-900' }),
    leg(3, 'Input SGST', 'Dr', 4500, { voucher_type: 'Purchase', gst_head: 'SGST', gst_rate: 9, bill_reference: 'MS-900' }),
    leg(3, 'Mumbai Suppliers', 'Cr', 59000, { voucher_type: 'Purchase', bill_reference: 'MS-900' }),
  ],
};

// 31 March 2025 baseline: a full year of sales and rent behind it.
const marchBaseline = trialBalance([
  ['Karnataka Emporium', 100000],
  ['Sales', -3211000],
  ['Rent', 303000],
  ['HDFC Bank — 1234', 800000],
  ['Output CGST', -50000],
  ['Output SGST', -50000],
  ['Purchases', 1729250],
  ['Cash', 5000],
  ['Capital', -925000],
  ['Salaries', 95000],
  ['Electricity Charges', 17450],
  ['Office Equipment', 192000],
  ['Mumbai Suppliers', -211000],
]);

describe('Trial Balance tie-out across the financial-year change', () => {
  it('measures profit-and-loss ledgers from zero when the export restarts the year, balance-sheet ledgers from the baseline', () => {
    const aprilExportNewYear = trialBalance([
      ['Karnataka Emporium', 123600],
      ['Sales', -20000],
      ['Rent', 10000],
      ['Purchases', 50000],
      ['HDFC Bank — 1234', 790000],
      ['Output CGST', -1800],
      ['Output SGST', -1800],
      ['Input CGST', 4500],
      ['Input SGST', 4500],
      ['Cash', 5000],
      ['Capital', -925000],
      ['Office Equipment', 192000],
      ['Mumbai Suppliers', -270000],
    ]);
    const withoutFlag = evaluateTrialBalanceTieOut(aprilExportNewYear, aprilKey, marchBaseline);
    expect(withoutFlag.tieOut).toBe(false);
    expect(withoutFlag.mismatches.map((m) => m.account)).toEqual(expect.arrayContaining(['sales', 'rent', 'purchases']));

    const withFlag = evaluateTrialBalanceTieOut(aprilExportNewYear, aprilKey, marchBaseline, { firstMonthOfFinancialYear: true });
    expect(withFlag.mismatches).toEqual([]);
    expect(withFlag.tieOut).toBe(true);
  });

  it('still accepts an export for the whole period since books began (cumulative profit-and-loss figures)', () => {
    const aprilExportCumulative = trialBalance([
      ['Karnataka Emporium', 123600],
      ['Sales', -3231000],
      ['Rent', 313000],
      ['HDFC Bank — 1234', 790000],
      ['Output CGST', -51800],
      ['Output SGST', -51800],
      ['Input CGST', 4500],
      ['Input SGST', 4500],
      ['Purchases', 1779250],
      ['Cash', 5000],
      ['Capital', -925000],
      ['Salaries', 95000],
      ['Electricity Charges', 17450],
      ['Office Equipment', 192000],
      ['Mumbai Suppliers', -270000],
    ]);
    const result = evaluateTrialBalanceTieOut(aprilExportCumulative, aprilKey, marchBaseline, { firstMonthOfFinancialYear: true });
    expect(result.mismatches).toEqual([]);
    expect(result.tieOut).toBe(true);
  });

  it('still catches a wrong April movement on a profit-and-loss ledger and on a balance-sheet ledger', () => {
    const wrong = trialBalance([
      ['Karnataka Emporium', 113600],
      ['Sales', -25000],
      ['Rent', 10000],
      ['Purchases', 50000],
      ['HDFC Bank — 1234', 790000],
      ['Output CGST', -1800],
      ['Output SGST', -1800],
      ['Input CGST', 4500],
      ['Input SGST', 4500],
      ['Cash', 5000],
      ['Capital', -925000],
      ['Office Equipment', 192000],
      ['Mumbai Suppliers', -270000],
    ]);
    const result = evaluateTrialBalanceTieOut(wrong, aprilKey, marchBaseline, { firstMonthOfFinancialYear: true });
    expect(result.tieOut).toBe(false);
    expect(result.mismatches.map((m) => m.account).sort()).toEqual(['karnataka emporium', 'sales']);
  });
});
