import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnswerKey, AnswerKeyEntry } from '@/lib/schemas/exercise';
import { cashPositionFromNet, netAnswerKeys, openAdvancesFromKeys, openBillsFromKeys, openingBalancesFromNet } from '@/lib/db/queries/company';
import { applyVoucher, cashPositionOf, openAdvancesOf, openBillsOf, openItemsOf, openingBalancesOf, replayKeys } from './ledger-state';

// Stage 1 of the rebuild (2026-09-22): one incremental state replaces the
// replays in company.ts. The prefix-parity block proves it reproduces them
// exactly over every prefix of the interns' stored keys (local fixtures;
// skipped when absent), so the cutover carries forward the same position
// the legacy path would have.

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

describe('applyVoucher', () => {
  it('raises a bill, settles it in part, then in full', () => {
    const state = replayKeys([]);
    applyVoucher(state, [
      leg(1, 'Sales', 'Karnataka Emporium', 'Dr', 70800, { bill_reference: 'INV-3001' }),
      leg(1, 'Sales', 'Sales', 'Cr', 70800, { bill_reference: 'INV-3001' }),
    ]);
    expect(openItemsOf(state)).toEqual([{ party: 'Karnataka Emporium', ref: 'INV-3001', key: 'INV-3001', kind: 'bill', side: 'receivable', open: 70800 }]);

    applyVoucher(state, [
      leg(2, 'Receipt', 'HDFC Bank — 1234', 'Dr', 20800, { bill_reference: 'INV-3001 (Against Ref, part payment)' }),
      leg(2, 'Receipt', 'Karnataka Emporium', 'Cr', 20800, { bill_reference: 'INV-3001 (Against Ref, part payment)' }),
    ]);
    expect(openItemsOf(state)[0].open).toBe(50000);
    expect(state.balances.get('Karnataka Emporium')).toBe(50000);
    expect(cashPositionOf(state)).toEqual({ cash: 0, bank: 20800 });

    // Spelled differently, the same bill (canonical identity).
    applyVoucher(state, [
      leg(3, 'Receipt', 'HDFC Bank — 1234', 'Dr', 50000, { bill_reference: 'Against Ref inv 3001' }),
      leg(3, 'Receipt', 'Karnataka Emporium', 'Cr', 50000, { bill_reference: 'Against Ref inv 3001' }),
    ]);
    expect(openItemsOf(state)).toEqual([]);
  });

  it('holds an advance as an open item until the same party\'s document adjusts it', () => {
    const state = replayKeys([]);
    applyVoucher(state, [
      leg(1, 'Payment', 'Bharat Machinery', 'Dr', 50000, { bill_reference: 'ADV-02 (Advance)' }),
      leg(1, 'Payment', 'HDFC Bank — 1234', 'Cr', 50000, { bill_reference: 'ADV-02 (Advance)' }),
    ]);
    expect(openAdvancesOf(state)).toEqual([{ party: 'Bharat Machinery', ref: 'ADV-02', key: 'ADV-2', kind: 'advance', side: 'payable', open: 50000 }]);
    expect(openBillsOf(state)).toEqual([]);

    applyVoucher(state, [
      leg(2, 'Purchase', 'Office Equipment', 'Dr', 100300, { bill_reference: 'ADV-02 (Advance), BM/2025-06' }),
      leg(2, 'Purchase', 'Bharat Machinery', 'Cr', 100300, { bill_reference: 'ADV-02 (Advance), BM/2025-06' }),
    ]);
    expect(openAdvancesOf(state)).toEqual([]);
    expect(openBillsOf(state)).toEqual([{ party: 'Bharat Machinery', ref: 'BM/2025-06', open: 50300, side: 'payable' }]);
  });

  it('applies a journal write-off to the bill its owner leg names', () => {
    const state = replayKeys([]);
    applyVoucher(state, [
      leg(1, 'Sales', 'Kerala Handicrafts', 'Dr', 141600, { bill_reference: 'INV-2231' }),
      leg(1, 'Sales', 'Sales', 'Cr', 141600, { bill_reference: 'INV-2231' }),
    ]);
    applyVoucher(state, [
      leg(2, 'Journal', 'Bad Debts Written Off', 'Dr', 20000, { bill_reference: 'INV-2231' }),
      leg(2, 'Journal', 'Kerala Handicrafts', 'Cr', 20000, { bill_reference: 'INV-2231' }),
    ]);
    expect(openBillsOf(state)).toEqual([{ party: 'Kerala Handicrafts', ref: 'INV-2231', open: 121600, side: 'receivable' }]);
  });

  it('resets the balances on a key that carries openings and can include tax ledgers', () => {
    const state = replayKeys([
      { entries: [leg(1, 'Sales', 'Cash', 'Dr', 100), leg(1, 'Sales', 'Sales', 'Cr', 100)] },
      {
        opening_balances: [
          { account: 'Cash', dr_cr: 'Dr', amount: 5000 },
          { account: 'Output CGST', dr_cr: 'Cr', amount: 900 },
          { account: 'Capital', dr_cr: 'Cr', amount: 4100 },
        ],
        entries: [],
      },
    ]);
    expect(cashPositionOf(state)).toEqual({ cash: 5000, bank: 0 });
    expect(openingBalancesOf(state).map((opening) => opening.account)).toEqual(['Cash', 'Capital']);
    expect(openingBalancesOf(state, { includeTaxLedgers: true }).map((opening) => opening.account)).toEqual(['Cash', 'Output CGST', 'Capital']);
  });
});

const FIXTURES = path.resolve(__dirname, '__fixtures__', 'keys');
const fixtureFiles = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((file) => file.endsWith('.json')) : [];

describe.skipIf(fixtureFiles.length === 0)('prefix parity with the company.ts replays over the stored keys', () => {
  it.each(fixtureFiles)('%s', (file) => {
    const rows = JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8')) as { answer_key: AnswerKey | null }[];
    const keys = rows.map((row) => row.answer_key).filter((key): key is AnswerKey => key !== null);
    expect(keys.length).toBeGreaterThan(5);
    const sortBills = (bills: { party: string; ref: string }[]) => [...bills].sort((a, b) => `${a.party}|${a.ref}`.localeCompare(`${b.party}|${b.ref}`));
    for (let n = 1; n <= keys.length; n += 1) {
      const prefix = keys.slice(0, n);
      const state = replayKeys(prefix);
      const net = netAnswerKeys(prefix);
      expect([...state.balances.entries()].sort(), `balances after ${n} keys`).toEqual([...net.entries()].sort());
      expect(cashPositionOf(state), `cash after ${n} keys`).toEqual(cashPositionFromNet(net));
      expect(openingBalancesOf(state), `openings after ${n} keys`).toEqual(openingBalancesFromNet(net));
      expect(sortBills(openBillsOf(state)), `open bills after ${n} keys`).toEqual(sortBills(openBillsFromKeys(prefix)));
      expect(
        sortBills(openAdvancesOf(state).map(({ party, ref, open, side }) => ({ party, ref, open, side }))),
        `open advances after ${n} keys`,
      ).toEqual(sortBills(openAdvancesFromKeys(prefix)));
    }
  });
});
