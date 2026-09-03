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
