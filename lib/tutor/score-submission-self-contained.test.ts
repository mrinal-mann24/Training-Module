import { describe, expect, it } from 'vitest';
import type { AnswerKey, AnswerKeyEntry } from '@/lib/schemas/exercise';
import type { ParsedTrialBalance } from '@/lib/schemas/voucher';
import { evaluateTrialBalanceTieOut, hasOpeningColumn } from './score-submission';

// 2026-09-11: a Trial Balance exported for the month carries Tally's
// opening column, so the month's movement is closing minus opening from
// the same file. A learner who corrects an earlier month after feedback is
// measured on this month alone, and no stored copy of an old export is
// needed (Praveen corrected SA/2027-04 in April after uploading April).

function leg(sequence: number, account: string, side: 'Dr' | 'Cr', amount: number, overrides: Partial<AnswerKeyEntry> = {}): AnswerKeyEntry {
  return {
    sequence,
    correct_account: account,
    dr_cr: side,
    amount,
    voucher_type: 'Purchase',
    gst_head: null,
    gst_rate: null,
    tds_section: null,
    tds_rate: null,
    tds_base: null,
    bill_reference: null,
    narration: null,
    concept_tags: ['purchase_voucher_basics'],
    requires_source_document: false,
    source_document_type: null,
    ...overrides,
  };
}

type Row = [name: string, opening: number, closing: number];
function monthExport(rows: Row[]): ParsedTrialBalance {
  return {
    ledgers: rows.map(([ledgerName, opening, closing]) => ({
      ledgerName,
      openingDebit: opening > 0 ? opening : 0,
      openingCredit: opening < 0 ? -opening : 0,
      closingDebit: closing > 0 ? closing : 0,
      closingCredit: closing < 0 ? -closing : 0,
    })),
  };
}

// May 2025: pay Signage Advertising's April bill in full, one new purchase.
const mayKey: AnswerKey = {
  entries: [
    leg(1, 'Signage Advertising', 'Dr', 25960, { voucher_type: 'Payment', bill_reference: 'SA/2027-04' }),
    leg(1, 'HDFC Bank — 1234', 'Cr', 25960, { voucher_type: 'Payment' }),
    leg(2, 'Purchases', 'Dr', 50000, { bill_reference: 'MS-900' }),
    leg(2, 'Input CGST', 'Dr', 4500, { gst_head: 'CGST', gst_rate: 9, bill_reference: 'MS-900' }),
    leg(2, 'Input SGST', 'Dr', 4500, { gst_head: 'SGST', gst_rate: 9, bill_reference: 'MS-900' }),
    leg(2, 'Mumbai Suppliers', 'Cr', 59000, { bill_reference: 'MS-900' }),
  ],
};

// The stored April export still shows the pre-correction 25,520.
const staleAprilExport: ParsedTrialBalance = {
  ledgers: [
    { ledgerName: 'Signage Advertising (firm)', closingDebit: 0, closingCredit: 25520 },
    { ledgerName: 'HDFC Bank - 1234', closingDebit: 989750, closingCredit: 0 },
    { ledgerName: 'Purchases 18%', closingDebit: 15000, closingCredit: 0 },
    { ledgerName: 'Mumbai Suppliers', closingDebit: 0, closingCredit: 211000 },
    { ledgerName: 'Cash', closingDebit: 2900, closingCredit: 0 },
    { ledgerName: 'Capital', closingDebit: 0, closingCredit: 925000 },
    { ledgerName: 'Office Equipment', closingDebit: 192000, closingCredit: 0 },
    { ledgerName: 'Rent', closingDebit: 40000, closingCredit: 0 },
    { ledgerName: 'Salaries', closingDebit: 95000, closingCredit: 0 },
    { ledgerName: 'Sales @18%', closingDebit: 0, closingCredit: 3871000 },
    { ledgerName: 'Kerala Handicrafts', closingDebit: 399200, closingCredit: 0 },
    { ledgerName: 'Delhi Bazaar', closingDebit: 74100, closingCredit: 0 },
    { ledgerName: 'Outstanding Expenses', closingDebit: 0, closingCredit: 111200 },
  ],
};

describe('self-contained Trial Balance tie-out', () => {
  it('reads the movement from the opening and closing columns and ignores a stale stored export', () => {
    // Opening reflects the corrected April (25,960), the bill is paid in May.
    const may = monthExport([
      ['Signage Advertising (firm)', -25960, 0],
      ['HDFC Bank - 1234', 989750, 963790],
      ['Purchases 18%', 15000, 65000],
      ['Input CGST 9%', 2780, 7280],
      ['Input SGST 9 %', 2780, 7280],
      ['Mumbai Suppliers', -211000, -270000],
      ['Cash', 2900, 2900],
    ]);
    expect(hasOpeningColumn(may)).toBe(true);
    const result = evaluateTrialBalanceTieOut(may, mayKey, staleAprilExport);
    expect(result.mismatches).toEqual([]);
    expect(result.tieOut).toBe(true);
  });

  it('still catches a wrong movement, and a ledger that should have moved but is absent', () => {
    const may = monthExport([
      ['Signage Advertising (firm)', -25960, -5960],
      ['HDFC Bank - 1234', 989750, 969750],
      ['Input CGST 9%', 2780, 7280],
      ['Input SGST 9 %', 2780, 7280],
      ['Mumbai Suppliers', -211000, -270000],
    ]);
    const result = evaluateTrialBalanceTieOut(may, mayKey, null);
    expect(result.tieOut).toBe(false);
    expect(result.mismatches).toEqual(
      expect.arrayContaining([
        { account: 'signage advertising', status: 'off', difference: -5960 },
        { account: 'hdfc bank — 1234', status: 'off', difference: 5960 },
        { account: 'purchases', status: 'missing', difference: -50000 },
      ]),
    );
  });

  it('falls back to the previous-export comparison when the file has no opening column', () => {
    const noOpenings: ParsedTrialBalance = {
      ledgers: [
        { ledgerName: 'Signage Advertising (firm)', closingDebit: 0, closingCredit: 0 },
        { ledgerName: 'HDFC Bank - 1234', closingDebit: 963790, closingCredit: 0 },
        { ledgerName: 'Purchases 18%', closingDebit: 65000, closingCredit: 0 },
        { ledgerName: 'Mumbai Suppliers', closingDebit: 0, closingCredit: 270000 },
        { ledgerName: 'Cash', closingDebit: 2900, closingCredit: 0 },
      ],
    };
    expect(hasOpeningColumn(noOpenings)).toBe(false);
    const result = evaluateTrialBalanceTieOut(noOpenings, mayKey, staleAprilExport);
    // Measured against the stale April copy, the April correction shows up as a May gap.
    expect(result.mismatches).toEqual([{ account: 'signage advertising', status: 'off', difference: -440 }]);
  });
});

describe('Tally group rows in a partially expanded export', () => {
  it('ignores the group row next to its ledger instead of counting both', () => {
    const key: AnswerKey = {
      entries: [
        leg(1, 'Karnataka Emporium', 'Dr', 130000, { voucher_type: 'Sales', bill_reference: 'INV-072' }),
        leg(1, 'Sales', 'Cr', 130000, { voucher_type: 'Sales' }),
      ],
    };
    const may = monthExport([
      ['Sales Accounts', 0, -130000],
      ['SALES', 0, -130000],
      ['Sundry Debtors', 100000, 230000],
      ['Karnataka Emporium', 100000, 230000],
    ]);
    const result = evaluateTrialBalanceTieOut(may, key, null);
    expect(result.mismatches).toEqual([]);
    expect(result.tieOut).toBe(true);
  });
});

describe('a suspense ledger named like the Tally group', () => {
  it('is a real ledger row, never filtered as a group (Garima, 2026-09-11)', () => {
    const key: AnswerKey = {
      entries: [
        leg(1, 'Suspense', 'Cr', 5000, { voucher_type: 'Receipt' }),
        leg(1, 'HDFC Bank — 1234', 'Dr', 5000, { voucher_type: 'Receipt' }),
      ],
    };
    const may = monthExport([
      ['SUSPENSE AC', 0, -5000],
      ['HDFC BANK', 100000, 105000],
    ]);
    expect(evaluateTrialBalanceTieOut(may, key, null).mismatches).toEqual([]);
  });
});
