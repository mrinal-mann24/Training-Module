import { describe, expect, it } from 'vitest';
import type { AnswerKey, AnswerKeyEntry, GeneratedExercise } from '@/lib/schemas/exercise';
import { documentNumberOf, openAdvancesFromKeys, openBillsFromKeys, type OpeningBalance } from '@/lib/db/queries/company';
import { adjustOpenAdvances, advancesToAdjust } from './advance-adjustment';
import { normalizeAccountName, partyAccountsOf } from './account-names';
import { evaluateBooksReconciliation, expectedClosingBalances } from './books-reconciliation';
import { advanceReferencesOf, billReferencesCorrect, canonicalBillReference } from './score-submission';
import { openAdvancesOf, replayKeys } from './ledger-state';

// Regression (2026-09-21, Praveen's June 2025 feedback). The April pack paid
// Bharat Machinery Rs 50,000 as ADV-02; June raised the bill BM/2025-06 for
// Rs 1,00,300 as a plain new bill, so his correct posting ("Agst Ref" the
// advance Rs 50,000, "New Ref" BM/2025-06 Rs 50,300) was marked
// BILL_REFERENCE_WRONG. Separately, the May bad-debt journal
// "Dr Bad Debts Written Off / Cr Delhi Bazaar" against INV-2231 made the
// expense ledger a party, so his June-only Trial Balance was told the ledger
// was missing.

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
    concept_tags: ['supplier_advance'],
    requires_source_document: false,
    source_document_type: null,
    ...extra,
  };
}

// The April pack's advance, exactly as stored (reference "ADV-02", no tag).
const april: AnswerKey = {
  entries: [
    leg(68, 'Payment', 'Bharat Machinery', 'Dr', 50000, { bill_reference: 'ADV-02' }),
    leg(68, 'Payment', 'HDFC Bank — 1234', 'Cr', 50000, { bill_reference: 'ADV-02' }),
  ],
};

const bharatBill = (reference: string) => [
  leg(9, 'Purchase', 'Office Equipment', 'Dr', 85000, { bill_reference: reference }),
  leg(9, 'Purchase', 'Input CGST', 'Dr', 7650, { bill_reference: reference, gst_head: 'CGST', gst_rate: 9 }),
  leg(9, 'Purchase', 'Input SGST', 'Dr', 7650, { bill_reference: reference, gst_head: 'SGST', gst_rate: 9 }),
  leg(9, 'Purchase', 'Bharat Machinery', 'Cr', 100300, { bill_reference: reference }),
];

function batch(entries: AnswerKeyEntry[]): GeneratedExercise {
  return {
    scenario: 'June 2025.',
    difficulty_level: 'L4',
    variant: 'A',
    transactions: [...new Set(entries.map((entry) => entry.sequence))].map((sequence) => ({ sequence, description: `Transaction ${sequence}.` })),
    answer_key: { entries },
  };
}

const juneOpenings: OpeningBalance[] = [
  { account: 'Bharat Machinery', dr_cr: 'Dr', amount: 50000 },
  { account: 'HDFC Bank — 1234', dr_cr: 'Dr', amount: 907150 },
];

describe('openAdvancesFromKeys', () => {
  it('keeps an advance open until a document names it, and leaves the bill list unchanged', () => {
    expect(openAdvancesFromKeys([april])).toEqual([{ party: 'Bharat Machinery', ref: 'ADV-02', open: 50000, side: 'payable' }]);
    expect(openBillsFromKeys([april])).toEqual([]);

    const adjusted: AnswerKey = { entries: bharatBill('ADV-02 (Advance), BM/2025-06') };
    expect(openAdvancesFromKeys([april, adjusted])).toEqual([]);
    expect(openBillsFromKeys([april, adjusted])).toEqual([{ party: 'Bharat Machinery', ref: 'BM/2025-06', open: 50300, side: 'payable' }]);
  });

  it('keeps what a smaller bill did not use', () => {
    const smallBill: AnswerKey = {
      entries: [
        leg(1, 'Purchase', 'Purchases', 'Dr', 20000, { bill_reference: 'ADV-02 (Advance), BM/2025-05' }),
        leg(1, 'Purchase', 'Bharat Machinery', 'Cr', 20000, { bill_reference: 'ADV-02 (Advance), BM/2025-05' }),
      ],
    };
    expect(openAdvancesFromKeys([april, smallBill])).toEqual([{ party: 'Bharat Machinery', ref: 'ADV-02', open: 30000, side: 'payable' }]);
  });

  it('records a customer advance on the receivable side', () => {
    const receipt: AnswerKey = {
      entries: [
        leg(1, 'Receipt', 'HDFC Bank — 1234', 'Dr', 45000, { bill_reference: 'ADV-C01 (Advance)' }),
        leg(1, 'Receipt', 'Bengaluru Boutique', 'Cr', 45000, { bill_reference: 'ADV-C01 (Advance)' }),
      ],
    };
    expect(openAdvancesFromKeys([receipt])).toEqual([{ party: 'Bengaluru Boutique', ref: 'ADV-C01', open: 45000, side: 'receivable' }]);
  });
});

describe('advancesToAdjust', () => {
  it('offers the advance while the supplier is still in debit', () => {
    expect(advancesToAdjust([april], juneOpenings)).toEqual([{ party: 'Bharat Machinery', ref: 'ADV-02', open: 50000, side: 'payable' }]);
  });

  it('offers nothing once the balance has turned, even though June never named the advance (Praveen\'s July)', () => {
    const juneAsStored: AnswerKey = { entries: bharatBill('BM/2025-06') };
    const julyOpenings: OpeningBalance[] = [{ account: 'Bharat Machinery', dr_cr: 'Cr', amount: 50300 }];
    expect(advancesToAdjust([april, juneAsStored], julyOpenings)).toEqual([]);
  });

  it('caps the advance at the debit the supplier still holds, and offers nothing without an opening', () => {
    expect(advancesToAdjust([april], [{ account: 'BHARAT MACHINERY', dr_cr: 'Dr', amount: 20000 }])[0].open).toBe(20000);
    expect(advancesToAdjust([april], [])).toEqual([]);
  });
});

describe('adjustOpenAdvances', () => {
  const advances = advancesToAdjust([april], juneOpenings);

  it('names the April advance on Bharat Machinery\'s June bill, on every leg, keeping the bill number', () => {
    const adjusted = adjustOpenAdvances(batch(bharatBill('BM/2025-06')), advances);
    for (const entry of adjusted.answer_key.entries) {
      expect(entry.bill_reference).toBe('ADV-02 (Advance), BM/2025-06');
    }
    expect(documentNumberOf(adjusted.answer_key.entries[0].bill_reference)).toBe('BM/2025-06');
    // Replayed forward, the advance is used up and the bill is open for the balance.
    expect(openAdvancesFromKeys([april, adjusted.answer_key])).toEqual([]);
    expect(openBillsFromKeys([april, adjusted.answer_key])).toEqual([{ party: 'Bharat Machinery', ref: 'BM/2025-06', open: 50300, side: 'payable' }]);
  });

  it('matches the party whatever its case, and uses the advance only once across two bills', () => {
    const twoBills = batch([
      leg(1, 'Purchase', 'Purchases', 'Dr', 30000, { bill_reference: 'BM/2025-06' }),
      leg(1, 'Purchase', 'BHARAT MACHINERY', 'Cr', 30000, { bill_reference: 'BM/2025-06' }),
      leg(2, 'Purchase', 'Purchases', 'Dr', 40000, { bill_reference: 'BM/2025-07' }),
      leg(2, 'Purchase', 'Bharat Machinery', 'Cr', 40000, { bill_reference: 'BM/2025-07' }),
      leg(3, 'Purchase', 'Purchases', 'Dr', 10000, { bill_reference: 'BM/2025-08' }),
      leg(3, 'Purchase', 'Bharat Machinery', 'Cr', 10000, { bill_reference: 'BM/2025-08' }),
    ]);
    const references = adjustOpenAdvances(twoBills, advances).answer_key.entries.map((entry) => entry.bill_reference);
    expect(references).toEqual([
      'ADV-02 (Advance), BM/2025-06',
      'ADV-02 (Advance), BM/2025-06',
      'ADV-02 (Advance), BM/2025-07',
      'ADV-02 (Advance), BM/2025-07',
      'BM/2025-08',
      'BM/2025-08',
    ]);
  });

  it('leaves other parties, payments, documents already naming an advance, and documents with no number alone', () => {
    const untouched = batch([
      leg(1, 'Purchase', 'Purchases', 'Dr', 10000, { bill_reference: 'DT/2027-09' }),
      leg(1, 'Purchase', 'Deccan Traders', 'Cr', 10000, { bill_reference: 'DT/2027-09' }),
      leg(2, 'Payment', 'Bharat Machinery', 'Dr', 5000, { bill_reference: 'BM/2025-01' }),
      leg(2, 'Payment', 'HDFC Bank — 1234', 'Cr', 5000, { bill_reference: 'BM/2025-01' }),
      leg(3, 'Purchase', 'Purchases', 'Dr', 10000, { bill_reference: 'ADV-09 (Advance), BM/2025-06' }),
      leg(3, 'Purchase', 'Bharat Machinery', 'Cr', 10000, { bill_reference: 'ADV-09 (Advance), BM/2025-06' }),
      leg(4, 'Purchase', 'Purchases', 'Dr', 10000),
      leg(4, 'Purchase', 'Bharat Machinery', 'Cr', 10000),
    ]);
    expect(adjustOpenAdvances(untouched, advances)).toBe(untouched);
  });

  it('adjusts a customer advance on that customer\'s next sales invoice', () => {
    const receipt: AnswerKey = {
      entries: [
        leg(1, 'Receipt', 'HDFC Bank — 1234', 'Dr', 45000, { bill_reference: 'ADV-C01 (Advance)' }),
        leg(1, 'Receipt', 'Bengaluru Boutique', 'Cr', 45000, { bill_reference: 'ADV-C01 (Advance)' }),
      ],
    };
    const customerAdvances = advancesToAdjust([receipt], [{ account: 'Bengaluru Boutique', dr_cr: 'Cr', amount: 45000 }]);
    const sale = batch([
      leg(1, 'Sales', 'Bengaluru Boutique', 'Dr', 70800, { bill_reference: 'INV-3101 (New Ref)' }),
      leg(1, 'Sales', 'Sales', 'Cr', 60000, { bill_reference: 'INV-3101 (New Ref)' }),
    ]);
    const references = adjustOpenAdvances(sale, customerAdvances).answer_key.entries.map((entry) => entry.bill_reference);
    expect(references).toEqual(['ADV-C01 (Advance), INV-3101 (New Ref)', 'ADV-C01 (Advance), INV-3101 (New Ref)']);
    // A supplier advance is never put on a sale.
    expect(adjustOpenAdvances(sale, advances)).toBe(sale);
  });
});

describe('scoring the adjusted key (advance names stay strict)', () => {
  const key: AnswerKey = { entries: bharatBill('ADV-02 (Advance), BM/2025-06') };
  const expectedLegs = key.entries;
  const posted = (...names: string[]) => {
    const tokens = new Set(names.map((name) => canonicalBillReference(name)!));
    return { tokens, advanceTokens: new Set<string>() };
  };

  it('accepts the advance adjusted by its name plus the bill as a new reference', () => {
    expect(billReferencesCorrect(expectedLegs, posted('ADV-02', 'BM/2025-06'), advanceReferencesOf(key))).toBe(true);
  });

  it('marks the whole bill booked as new wrong, and an advance under another name wrong', () => {
    expect(billReferencesCorrect(expectedLegs, posted('BM/2025-06'), advanceReferencesOf(key))).toBe(false);
    expect(billReferencesCorrect(expectedLegs, posted('17', 'BM/2025-06'), advanceReferencesOf(key))).toBe(false);
  });
});

describe('a journal\'s expense leg is not a party (Bad Debts Written Off)', () => {
  const writeOff = [
    leg(1, 'Journal', 'Bad Debts Written Off', 'Dr', 20000, { bill_reference: 'INV-2231' }),
    leg(1, 'Journal', 'Kerala Handicrafts', 'Cr', 20000, { bill_reference: 'INV-2231' }),
  ];

  it('keeps the customer as the party and the expense ledger out', () => {
    const parties = partyAccountsOf(writeOff);
    expect([...parties]).toEqual([normalizeAccountName('Kerala Handicrafts')]);
  });

  it('accepts a month-only export that leaves out the write-off in a month with no bad debts', () => {
    const may: AnswerKey = { entries: writeOff };
    const june: AnswerKey = {
      entries: [
        leg(1, 'Sales', 'Cash', 'Dr', 14160, { voucher_type: 'Sales' }),
        leg(1, 'Sales', 'Sales', 'Cr', 14160, { voucher_type: 'Sales' }),
      ],
    };
    const expected = expectedClosingBalances([may, june], 1);
    const badDebts = expected.find((item) => item.account === 'Bad Debts Written Off')!;
    expect(badDebts.kind).toBe('profit_and_loss');
    expect(badDebts.monthMovement).toBe(0);
    expect(evaluateBooksReconciliation({ ledgers: [] }, [badDebts]).differences).toEqual([]);
  });
});

// Praveen's June 2025 (2026-09-22): the STORED key names only "BM/2025-06",
// written before the generator adjusted open advances. A learner who adjusts
// the April advance by its proper name must not be marked wrong for the
// extra allocation; the scoring job passes the advances open before the
// batch. The name stays strict: his own label "17" is still wrong.
describe('an advance open from an earlier month on a key that does not name it', () => {
  const storedKey: AnswerKey = { entries: bharatBill('BM/2025-06') };
  const posted = (...names: string[]) => ({ tokens: new Set(names.map((name) => canonicalBillReference(name)!)), advanceTokens: new Set<string>() });
  const april: AnswerKey = {
    entries: [
      { ...bharatBill('ADV-02 (Advance)')[0], sequence: 1, voucher_type: 'Payment', correct_account: 'Bharat Machinery', dr_cr: 'Dr', amount: 50000 },
      { ...bharatBill('ADV-02 (Advance)')[0], sequence: 1, voucher_type: 'Payment', correct_account: 'HDFC Bank — 1234', dr_cr: 'Cr', amount: 50000 },
    ],
  };
  const openBefore = new Set(openAdvancesOf(replayKeys([april])).map((item) => item.key));

  it('reads the open advance from the earlier keys in the canonical form the scorer uses', () => {
    expect([...openBefore]).toEqual([canonicalBillReference('ADV-02')]);
  });

  it('accepts the adjustment by name once the open advances are passed, and only then', () => {
    expect(billReferencesCorrect(storedKey.entries, posted('ADV-02', 'BM/2025-06'), advanceReferencesOf(storedKey))).toBe(false);
    expect(billReferencesCorrect(storedKey.entries, posted('ADV-02', 'BM/2025-06'), openBefore)).toBe(true);
    expect(billReferencesCorrect(storedKey.entries, posted('BM/2025-06'), openBefore)).toBe(true);
    expect(billReferencesCorrect(storedKey.entries, posted('17', 'BM/2025-06'), openBefore)).toBe(false);
  });
});
