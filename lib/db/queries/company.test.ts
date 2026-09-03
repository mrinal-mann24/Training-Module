import { describe, expect, it } from 'vitest';
import type { AnswerKey } from '@/lib/schemas/exercise';
import { cashPositionFromNet, netAnswerKeys, openingBalancesFromNet } from './company';

const leg = (
  sequence: number,
  account: string,
  drCr: 'Dr' | 'Cr',
  amount: number,
): AnswerKey['entries'][number] => ({
  sequence,
  correct_account: account,
  dr_cr: drCr,
  amount,
  voucher_type: 'Contra',
  gst_head: null,
  gst_rate: null,
  tds_section: null,
  tds_rate: null,
  tds_base: null,
  bill_reference: null,
  narration: null,
  concept_tags: ['contra_voucher_basics'],
  requires_source_document: false,
  source_document_type: null,
});

// April (diagnostic pack): opens with Cash 5,000 / HDFC 100,000, moves
// +14,900 into cash. May (generated, stamped with April's CLOSING as its
// openings): moves 75,000 out of cash. The correct June opening is
// 19,900 - 75,000 = -55,100 — Praveen's real Tally figure (2026-09-02).
const april: AnswerKey = {
  opening_balances: [
    { account: 'Cash', dr_cr: 'Dr', amount: 5000 },
    { account: 'HDFC Bank — 1234', dr_cr: 'Dr', amount: 100000 },
    { account: 'Capital — Anita Rao', dr_cr: 'Cr', amount: 105000 },
  ],
  entries: [leg(1, 'Cash', 'Dr', 14900), leg(1, 'HDFC Bank — 1234', 'Cr', 14900)],
};
const may: AnswerKey = {
  opening_balances: [
    { account: 'Cash', dr_cr: 'Dr', amount: 19900 },
    { account: 'HDFC Bank — 1234', dr_cr: 'Dr', amount: 85100 },
    { account: 'Capital — Anita Rao', dr_cr: 'Cr', amount: 105000 },
  ],
  entries: [leg(1, 'HDFC Bank — 1234', 'Dr', 75000), leg(1, 'Cash', 'Cr', 75000)],
};

describe('netAnswerKeys (cumulative openings must RESET, not accumulate)', () => {
  it('does not count April twice when May carries April closing as its openings', () => {
    const net = netAnswerKeys([april, may]);
    expect(net.get('Cash')).toBe(-55100);
    expect(net.get('HDFC Bank — 1234')).toBe(160100);
    expect(net.get('Capital — Anita Rao')).toBe(-105000);
  });

  it('the live double-count would have said -35,200 for the till', () => {
    // Regression guard: the old rule summed every key's openings + entries.
    const wrong = 5000 + 14900 + 19900 - 75000;
    expect(wrong).toBe(-35200);
    expect(netAnswerKeys([april, may]).get('Cash')).not.toBe(wrong);
  });

  it('adds a key without openings on top of the running position', () => {
    const june: AnswerKey = { entries: [leg(1, 'Cash', 'Dr', 70000), leg(1, 'HDFC Bank — 1234', 'Cr', 70000)] };
    expect(netAnswerKeys([april, may, june]).get('Cash')).toBe(14900);
  });

  it('shapes the cash position and opening balances off the same net', () => {
    const net = netAnswerKeys([april, may]);
    expect(cashPositionFromNet(net)).toEqual({ cash: -55100, bank: 160100 });
    expect(openingBalancesFromNet(net)).toEqual(
      expect.arrayContaining([
        { account: 'Cash', dr_cr: 'Cr', amount: 55100 },
        { account: 'HDFC Bank — 1234', dr_cr: 'Dr', amount: 160100 },
        { account: 'Capital — Anita Rao', dr_cr: 'Cr', amount: 105000 },
      ]),
    );
  });

  it('keeps GST/TDS ledgers out of the carried-forward openings', () => {
    const withTax: AnswerKey = {
      opening_balances: [{ account: 'Input CGST c/f', dr_cr: 'Dr', amount: 5000 }, { account: 'Cash', dr_cr: 'Dr', amount: 100 }],
      entries: [],
    };
    expect(openingBalancesFromNet(netAnswerKeys([withTax]))).toEqual([{ account: 'Cash', dr_cr: 'Dr', amount: 100 }]);
  });
});

import { isBankLedger } from './company';

describe('bank ledger recognition (Bank Charges is an expense, not the bank — 2026-09-03)', () => {
  it('keeps expense/income ledgers named after the bank out of the bank position', () => {
    expect(isBankLedger('HDFC Bank — 1234')).toBe(true);
    expect(isBankLedger('Bank Accounts')).toBe(true);
    expect(isBankLedger('Bank Charges')).toBe(false);
    expect(isBankLedger('Bank Interest')).toBe(false);
    expect(isBankLedger('Cash')).toBe(false);
  });

  it('does not inflate the bank position by the charges balance', () => {
    const net = new Map<string, number>([['HDFC Bank — 1234', 808176], ['Bank Charges', 1070.34], ['Cash', 11400]]);
    expect(cashPositionFromNet(net)).toEqual({ cash: 11400, bank: 808176 });
  });
});

import { openBillsFromKeys } from './company';

describe('openBillsFromKeys (bill-by-bill state from the answer keys, 2026-09-03)', () => {
  const entry = (sequence: number, account: string, drCr: 'Dr' | 'Cr', amount: number, voucherType: string, ref: string | null): AnswerKey['entries'][number] => ({
    ...leg(sequence, account, drCr, amount),
    voucher_type: voucherType,
    bill_reference: ref,
  });
  const april: AnswerKey = {
    entries: [
      entry(1, 'Deccan Traders', 'Cr', 69620, 'Purchase', 'DT/334'),
      entry(1, 'Purchases', 'Dr', 59000, 'Purchase', 'DT/334'),
      entry(2, 'Delhi Bazaar', 'Dr', 177000, 'Sales', 'INV-003'),
      entry(2, 'Sales', 'Cr', 150000, 'Sales', 'INV-003'),
      entry(3, 'Delhi Bazaar', 'Cr', 155000, 'Receipt', 'Against INV-003 (part)'),
      entry(3, 'HDFC Bank — 1234', 'Dr', 155000, 'Receipt', 'Against INV-003 (part)'),
      entry(4, 'Chennai Suppliers', 'Cr', 106200, 'Purchase', 'CS-091'),
      entry(5, 'Chennai Suppliers', 'Dr', 106200, 'Payment', 'CS-091'),
    ],
  };

  it('nets raises against settlements per party and reference', () => {
    const bills = openBillsFromKeys([april]);
    expect(bills).toEqual(
      expect.arrayContaining([
        { party: 'Deccan Traders', ref: 'DT/334', open: 69620, side: 'payable' },
        { party: 'Delhi Bazaar', ref: 'INV-003', open: 22000, side: 'receivable' },
      ]),
    );
    expect(bills.some((bill) => bill.party === 'Chennai Suppliers')).toBe(false);
  });
});

describe('openBillsFromKeys: party is found by voucher side (Praveen Level 5, 2026-09-03)', () => {
  const entry = (sequence: number, account: string, drCr: 'Dr' | 'Cr', amount: number, voucherType: string, ref: string | null): AnswerKey['entries'][number] => ({
    ...leg(sequence, account, drCr, amount),
    voucher_type: voucherType,
    bill_reference: ref,
  });
  it('an asset purchase listed expense-first still nets against the supplier payment', () => {
    const april: AnswerKey = {
      entries: [
        // April pack shape: expense/asset leg first, supplier last.
        entry(1, 'Office Equipment', 'Dr', 80000, 'Purchase', 'DT-115'),
        entry(1, 'Input CGST', 'Dr', 7200, 'Purchase', 'DT-115'),
        entry(1, 'Input SGST', 'Dr', 7200, 'Purchase', 'DT-115'),
        entry(1, 'Deccan Traders', 'Cr', 94400, 'Purchase', 'DT-115'),
        entry(2, 'Deccan Traders', 'Dr', 94400, 'Payment', 'DT-115'),
        entry(2, 'HDFC Bank — 1234', 'Cr', 94400, 'Payment', 'DT-115'),
      ],
    };
    const bills = openBillsFromKeys([april]);
    expect(bills.some((bill) => bill.party === 'Office Equipment')).toBe(false);
    expect(bills.some((bill) => bill.ref === 'DT-115')).toBe(false);
  });
});
