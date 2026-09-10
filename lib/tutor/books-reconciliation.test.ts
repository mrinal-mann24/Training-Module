import { describe, expect, it } from 'vitest';
import type { AnswerKey, AnswerKeyEntry } from '@/lib/schemas/exercise';
import { classifyLedger, evaluateBooksReconciliation, expectedClosingBalances } from './books-reconciliation';

function leg(sequence: number, account: string, side: 'Dr' | 'Cr', amount: number, overrides: Partial<AnswerKeyEntry> = {}): AnswerKeyEntry {
  return {
    sequence,
    correct_account: account,
    dr_cr: side,
    amount,
    voucher_type: 'Journal',
    gst_head: null,
    gst_rate: null,
    tds_section: null,
    tds_rate: null,
    tds_base: null,
    bill_reference: null,
    narration: null,
    concept_tags: ['journal_voucher_basics'],
    requires_source_document: false,
    source_document_type: null,
    ...overrides,
  };
}

// Pack (April): openings + one credit sale. Then eleven empty months, then
// a second-year batch (ordinal 12) with a sale and a receipt.
const pack: AnswerKey = {
  opening_balances: [
    { account: 'HDFC Bank — 1234', dr_cr: 'Dr', amount: 800000 },
    { account: 'Capital — Anita Rao', dr_cr: 'Cr', amount: 800000 },
  ],
  entries: [
    leg(1, 'Karnataka Emporium', 'Dr', 59000, { voucher_type: 'Sales', bill_reference: 'INV-001' }),
    leg(1, 'Sales', 'Cr', 50000, { voucher_type: 'Sales' }),
    leg(1, 'Output CGST', 'Cr', 4500, { voucher_type: 'Sales', gst_head: 'CGST', gst_rate: 18 }),
    leg(1, 'Output SGST', 'Cr', 4500, { voucher_type: 'Sales', gst_head: 'SGST', gst_rate: 18 }),
  ],
};
const emptyMonth = (): AnswerKey => ({ entries: [] });
const secondYear: AnswerKey = {
  entries: [
    leg(1, 'Delhi Bazaar', 'Dr', 11800, { voucher_type: 'Sales', bill_reference: 'INV-002' }),
    leg(1, 'Sales', 'Cr', 10000, { voucher_type: 'Sales' }),
    leg(1, 'Output IGST', 'Cr', 1800, { voucher_type: 'Sales', gst_head: 'IGST', gst_rate: 18 }),
    leg(2, 'HDFC Bank — 1234', 'Dr', 59000, { voucher_type: 'Receipt' }),
    leg(2, 'Karnataka Emporium', 'Cr', 59000, { voucher_type: 'Receipt', bill_reference: 'INV-001' }),
    leg(3, 'Rent', 'Dr', 25000, { voucher_type: 'Payment' }),
    leg(3, 'HDFC Bank — 1234', 'Cr', 25000, { voucher_type: 'Payment' }),
  ],
};
const keys = [pack, ...Array.from({ length: 11 }, emptyMonth), secondYear];

describe('classifyLedger', () => {
  it('knows parties, balance-sheet and profit-and-loss names, and leaves tax and unknown out', () => {
    const parties = new Set(['signageadvertisingfirm']);
    expect(classifyLedger('Signage Advertising (firm)', parties)).toBe('balance_sheet');
    expect(classifyLedger('Advertisement & Marketing', new Set())).toBe('profit_and_loss');
    expect(classifyLedger('HDFC Bank — 1234', new Set())).toBe('balance_sheet');
    expect(classifyLedger('Outstanding Expenses', new Set())).toBe('balance_sheet');
    expect(classifyLedger('Input CGST', new Set())).toBe('tax');
    expect(classifyLedger('Mystery Ledger', new Set())).toBe('unknown');
  });
});

describe('expectedClosingBalances', () => {
  it('accumulates balance-sheet ledgers and restarts profit-and-loss ledgers each year', () => {
    const expected = expectedClosingBalances(keys, 12);
    const byAccount = new Map(expected.map((item) => [item.account, item]));
    // Bank: 8,00,000 + 59,000 - 25,000 across both years.
    expect(byAccount.get('HDFC Bank — 1234')?.expected).toBe(834000);
    expect(byAccount.get('HDFC Bank — 1234')?.kind).toBe('balance_sheet');
    // Karnataka Emporium settled in year two: 59,000 - 59,000.
    expect(byAccount.get('Karnataka Emporium')?.expected).toBe(0);
    // Sales restarts: only the second-year sale counts.
    expect(byAccount.get('Sales')?.expected).toBe(-10000);
    expect(byAccount.get('Rent')?.expected).toBe(25000);
    // Tax ledgers are never listed.
    expect(byAccount.has('Output CGST')).toBe(false);
  });

  it('in the first year profit-and-loss ledgers are simply cumulative', () => {
    const expected = expectedClosingBalances(keys, 0);
    expect(expected.find((item) => item.account === 'Sales')?.expected).toBe(-50000);
    expect(expected.find((item) => item.account === 'Karnataka Emporium')?.expected).toBe(59000);
  });
});

describe('evaluateBooksReconciliation', () => {
  const expected = expectedClosingBalances(keys, 12);

  it('is clean when every ledger closes at the correct figure', () => {
    const trialBalance = {
      ledgers: [
        { ledgerName: 'HDFC Bank — 1234', closingDebit: 834000, closingCredit: 0 },
        { ledgerName: 'Capital — Anita Rao', closingDebit: 0, closingCredit: 800000 },
        { ledgerName: 'Delhi Bazaar', closingDebit: 11800, closingCredit: 0 },
        { ledgerName: 'Sales', closingDebit: 0, closingCredit: 10000 },
        { ledgerName: 'Rent A/c', closingDebit: 25000, closingCredit: 0 },
      ],
    };
    expect(evaluateBooksReconciliation(trialBalance, expected).differences).toEqual([]);
  });

  it('names the ledgers that are off or missing, largest gap first, never the expected figure', () => {
    const trialBalance = {
      ledgers: [
        { ledgerName: 'HDFC Bank — 1234', closingDebit: 800000, closingCredit: 0 },
        { ledgerName: 'Capital — Anita Rao', closingDebit: 0, closingCredit: 800000 },
        { ledgerName: 'Sales', closingDebit: 0, closingCredit: 10000 },
        { ledgerName: 'Rent A/c', closingDebit: 25000, closingCredit: 0 },
      ],
    };
    const { differences } = evaluateBooksReconciliation(trialBalance, expected);
    expect(differences).toEqual([
      { account: 'HDFC Bank — 1234', status: 'off', difference: -34000 },
      { account: 'Delhi Bazaar', status: 'missing', difference: -11800 },
    ]);
  });
});
