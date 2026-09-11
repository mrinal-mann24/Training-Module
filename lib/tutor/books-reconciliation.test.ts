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
    expect(classifyLedger('BANK CHARGES', new Set())).toBe('profit_and_loss');
    expect(classifyLedger('Cash Discount', new Set())).toBe('profit_and_loss');
    expect(classifyLedger('Bank Accounts', new Set())).toBe('balance_sheet');
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

  it('offers the whole-period figure as an alternative for profit-and-loss ledgers after the first year (an export since books began)', () => {
    const expected = expectedClosingBalances(keys, 12);
    const sales = expected.find((item) => item.account === 'Sales');
    expect(sales?.alternative).toBe(-60000);
    expect(expected.find((item) => item.account === 'HDFC Bank — 1234')?.alternative).toBeUndefined();
    const wholePeriodExport = { ledgers: [{ ledgerName: 'Sales', closingDebit: 0, closingCredit: 60000 }] } as unknown as Parameters<typeof evaluateBooksReconciliation>[0];
    expect(evaluateBooksReconciliation(wholePeriodExport, [sales!]).differences).toEqual([]);
    const wrongEitherWay = { ledgers: [{ ledgerName: 'Sales', closingDebit: 0, closingCredit: 40000 }] } as unknown as Parameters<typeof evaluateBooksReconciliation>[0];
    expect(evaluateBooksReconciliation(wrongEitherWay, [sales!]).differences).toEqual([{ account: 'Sales', status: 'off', difference: 20000 }]);
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

describe('aliases on returns ledgers', () => {
  it('drops an alias that names the base ledger of a returns ledger (an old key aliased Sales Returns as "Sales")', () => {
    const entry = {
      sequence: 1,
      correct_account: 'Sales Returns',
      dr_cr: 'Dr' as const,
      amount: 8000,
      voucher_type: 'Credit Note',
      gst_head: null,
      gst_rate: null,
      tds_section: null,
      tds_rate: null,
      tds_base: null,
      bill_reference: 'INV-009',
      narration: null,
      concept_tags: ['sales_voucher_basics' as const],
      requires_source_document: false,
      source_document_type: null,
      account_aliases: ['Sales Return', 'Sales', 'Credit Sales A/c'],
    };
    const expected = expectedClosingBalances([{ entries: [entry] }], 0);
    expect(expected.find((item) => item.account === 'Sales Returns')?.aliases).toEqual(['Sales Return']);
  });
});

describe('month-only exports of profit-and-loss ledgers (Praveen, May 2025)', () => {
  // Two second-year months: the sale repeats, so year to date is twice the month.
  const twoMonths = [...keys, secondYear];

  it('accepts the month figure, the year-to-date figure or the whole-period figure, and an absent ledger that did not move this month', () => {
    const expected = expectedClosingBalances(twoMonths, 13);
    const sales = expected.find((item) => item.account === 'Sales')!;
    expect(sales.expected).toBe(-20000);
    expect(sales.monthMovement).toBe(-10000);
    const monthOnly = { ledgers: [{ ledgerName: 'Sales', openingDebit: 0, openingCredit: 0, closingDebit: 0, closingCredit: 10000 }] } as unknown as Parameters<typeof evaluateBooksReconciliation>[0];
    expect(evaluateBooksReconciliation(monthOnly, [sales]).differences).toEqual([]);
    const yearToDate = { ledgers: [{ ledgerName: 'Sales', closingDebit: 0, closingCredit: 20000 }] } as unknown as Parameters<typeof evaluateBooksReconciliation>[0];
    expect(evaluateBooksReconciliation(yearToDate, [sales]).differences).toEqual([]);
    // Rent moved only in the first second-year month: absent from the next month's export is fine.
    const rent = expectedClosingBalances([...twoMonths, { entries: [] }], 14).find((item) => item.account === 'Rent')!;
    expect(rent.monthMovement).toBe(0);
    expect(evaluateBooksReconciliation({ ledgers: [] }, [rent]).differences).toEqual([]);
  });
});

describe('a party row is never lent to an expense ledger through an alias', () => {
  it('keeps Signage Advertising with the vendor when Advertisement & Marketing carries the alias "Advertising"', () => {
    const key: AnswerKey = {
      entries: [
        leg(1, 'Advertisement & Marketing', 'Dr', 22000, { voucher_type: 'Purchase', bill_reference: 'SA/2027-04', account_aliases: ['Advertising', 'Marketing Expenses'] }),
        leg(1, 'Signage Advertising', 'Cr', 22000, { voucher_type: 'Purchase', bill_reference: 'SA/2027-04' }),
      ],
    };
    const expected = expectedClosingBalances([key, { entries: [] }], 1);
    const vendorOnly = { ledgers: [{ ledgerName: 'Signage Advertising (firm)', openingDebit: 0, openingCredit: 22000, closingDebit: 0, closingCredit: 22000 }] } as unknown as Parameters<typeof evaluateBooksReconciliation>[0];
    // The expense ledger did not move this month, so its absence is fine; the vendor row is the vendor's.
    expect(evaluateBooksReconciliation(vendorOnly, expected).differences).toEqual([]);
  });
});
