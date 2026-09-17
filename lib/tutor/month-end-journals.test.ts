import { describe, expect, it } from 'vitest';
import type { AnswerKey, AnswerKeyEntry, GeneratedExercise } from '@/lib/schemas/exercise';
import { appendMonthEndJournals, buildGstSetOff, emptyGstPosition, gstPositionFromKeys, optimiseSetOff } from './month-end-journals';

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

describe('gstPositionFromKeys', () => {
  it('reads metadata GST on a pack-style key and ledger legs on a generated key', () => {
    const pack: AnswerKey = {
      opening_balances: [{ account: 'Input CGST c/f', dr_cr: 'Dr', amount: 5000 }],
      entries: [
        // Sale 1,00,000 + IGST 18% as metadata on both legs.
        leg(1, 'Delhi Bazaar', 'Dr', 118000, { gst_head: 'IGST', gst_rate: 18 }),
        leg(1, 'Sales', 'Cr', 100000, { gst_head: 'IGST', gst_rate: 18 }),
        // Purchase 50,000 + CGST/SGST as metadata.
        leg(2, 'Purchases', 'Dr', 50000, { voucher_type: 'Purchase', gst_head: 'CGST', gst_rate: 18 }),
        leg(2, 'Deccan Traders', 'Cr', 59000, { voucher_type: 'Purchase', gst_head: 'CGST', gst_rate: 18 }),
      ],
    };
    const generated: AnswerKey = {
      entries: [
        leg(1, 'Karnataka Emporium', 'Dr', 23600),
        leg(1, 'Sales', 'Cr', 20000),
        leg(1, 'Output CGST', 'Cr', 1800, { gst_head: 'CGST', gst_rate: 18 }),
        leg(1, 'Output SGST', 'Cr', 1800, { gst_head: 'SGST', gst_rate: 18 }),
      ],
    };
    const position = gstPositionFromKeys([pack, generated]);
    expect(position.output).toEqual({ IGST: 18000, CGST: 1800, SGST: 1800 });
    expect(position.input).toEqual({ IGST: 0, CGST: 9500, SGST: 4500 });
    expect(position.payable).toBe(0);
  });
});

describe('buildGstSetOff', () => {
  it('utilises IGST credit first, then CGST and SGST against their own heads, and moves the rest to GST Payable', () => {
    const setOff = buildGstSetOff({
      ...emptyGstPosition(),
      output: { IGST: 18000, CGST: 6000, SGST: 6000 },
      input: { IGST: 20000, CGST: 2000, SGST: 500 },
      payable: 1000,
    });
    expect(setOff?.legs).toEqual([
      { account: 'Output IGST', dr_cr: 'Dr', amount: 18000 },
      { account: 'Input IGST', dr_cr: 'Cr', amount: 18000 },
      { account: 'Output CGST', dr_cr: 'Dr', amount: 2000 },
      { account: 'Input IGST', dr_cr: 'Cr', amount: 2000 },
      { account: 'Output CGST', dr_cr: 'Dr', amount: 2000 },
      { account: 'Input CGST', dr_cr: 'Cr', amount: 2000 },
      { account: 'Output SGST', dr_cr: 'Dr', amount: 500 },
      { account: 'Input SGST', dr_cr: 'Cr', amount: 500 },
      { account: 'Output CGST', dr_cr: 'Dr', amount: 2000 },
      { account: 'Output SGST', dr_cr: 'Dr', amount: 5500 },
      { account: 'GST Payable', dr_cr: 'Cr', amount: 7500 },
    ]);
    expect(setOff?.after).toEqual({ ...emptyGstPosition(), payable: 8500 });
    // The journal balances.
    const dr = setOff!.legs.filter((l) => l.dr_cr === 'Dr').reduce((s, l) => s + l.amount, 0);
    const cr = setOff!.legs.filter((l) => l.dr_cr === 'Cr').reduce((s, l) => s + l.amount, 0);
    expect(dr).toBe(cr);
  });

  it('returns null when there is no output liability', () => {
    expect(buildGstSetOff({ ...emptyGstPosition(), input: { IGST: 500, CGST: 0, SGST: 0 } })).toBeNull();
  });
});

describe('appendMonthEndJournals', () => {
  const batch: GeneratedExercise = {
    scenario: 'Batch.',
    difficulty_level: 'L2',
    variant: 'A',
    transactions: [
      { sequence: 1, description: 'On 05-May-2025, sold goods to Karnataka Emporium, INV-060.' },
      { sequence: 2, description: 'On 31-May-2025, set off GST (model attempt).' },
    ],
    answer_key: {
      entries: [
        leg(1, 'Karnataka Emporium', 'Dr', 23600, { bill_reference: 'INV-060' }),
        leg(1, 'Sales', 'Cr', 20000),
        leg(1, 'Output CGST', 'Cr', 1800, { gst_head: 'CGST', gst_rate: 18 }),
        leg(1, 'Output SGST', 'Cr', 1800, { gst_head: 'SGST', gst_rate: 18 }),
        leg(2, 'Output CGST', 'Dr', 44310, { voucher_type: 'Journal' }),
        leg(2, 'Input CGST', 'Cr', 44310, { voucher_type: 'Journal' }),
      ],
    },
  };
  const priorKeys: AnswerKey[] = [
    {
      opening_balances: [{ account: 'GST Payable', dr_cr: 'Cr', amount: 4000 }],
      entries: [
        leg(1, 'Purchases', 'Dr', 10000, { voucher_type: 'Purchase' }),
        leg(1, 'Input CGST', 'Dr', 900, { voucher_type: 'Purchase', gst_head: 'CGST', gst_rate: 18 }),
        leg(1, 'Input SGST', 'Dr', 900, { voucher_type: 'Purchase', gst_head: 'SGST', gst_rate: 18 }),
        leg(1, 'Mumbai Suppliers', 'Cr', 11800, { voucher_type: 'Purchase' }),
      ],
    },
  ];

  it('drops the model set-off, pays last month\'s liability and appends a set-off computed from the ledger', () => {
    const result = appendMonthEndJournals(batch, {
      priorKeys,
      concepts: ['gst_set_off', 'gst_payment'],
      month: { monthIndex: 4, year: 2025 },
      licenseMode: 'licensed',
      bankAccount: 'HDFC Bank — 1234',
      bankAfterBatch: 500000,
    });
    expect(result.appended).toEqual({ setOff: true, payment: true });
    expect(result.generated.transactions.map((t) => t.sequence)).toEqual([1, 2, 3]);
    expect(result.generated.transactions[1].description).toContain('On 20-May-2025');
    expect(result.generated.transactions[1].description).toContain('Rs 4,000');
    expect(result.generated.transactions[2].description).toContain('On 31-May-2025');
    const payment = result.generated.answer_key.entries.filter((e) => e.sequence === 2);
    expect(payment.map((e) => [e.correct_account, e.dr_cr, e.amount])).toEqual([
      ['GST Payable', 'Dr', 4000],
      ['HDFC Bank — 1234', 'Cr', 4000],
    ]);
    const setOff = result.generated.answer_key.entries.filter((e) => e.sequence === 3);
    // Output 1,800 + 1,800 against input 900 + 900; the rest to GST Payable.
    expect(setOff.map((e) => [e.correct_account, e.dr_cr, e.amount])).toEqual([
      ['Output CGST', 'Dr', 900],
      ['Input CGST', 'Cr', 900],
      ['Output SGST', 'Dr', 900],
      ['Input SGST', 'Cr', 900],
      ['Output CGST', 'Dr', 900],
      ['Output SGST', 'Dr', 900],
      ['GST Payable', 'Cr', 1800],
    ]);
    expect(setOff.every((e) => e.concept_tags.includes('gst_set_off'))).toBe(true);
    // The invented journal is gone.
    expect(result.generated.answer_key.entries.some((e) => e.amount === 44310)).toBe(false);
  });

  it('dates the payment on the 2nd for educational-mode learners and skips it when nothing is payable', () => {
    const educational = appendMonthEndJournals(batch, {
      priorKeys,
      concepts: ['gst_payment'],
      month: { monthIndex: 4, year: 2025 },
      licenseMode: 'educational',
      bankAccount: 'HDFC Bank — 1234',
      bankAfterBatch: 500000,
    });
    expect(educational.generated.transactions[1].description).toContain('On 02-May-2025');
    const nothingPayable = appendMonthEndJournals(batch, {
      priorKeys: [],
      concepts: ['gst_payment'],
      month: { monthIndex: 4, year: 2025 },
      licenseMode: 'licensed',
      bankAccount: 'HDFC Bank — 1234',
      bankAfterBatch: 500000,
    });
    expect(nothingPayable.appended.payment).toBe(false);
  });

  it('dates the set-off on the 31st for educational learners in a 31-day month (2026-09-16)', () => {
    const result = appendMonthEndJournals(batch, {
      priorKeys,
      concepts: ['gst_set_off', 'gst_payment'],
      month: { monthIndex: 4, year: 2025 },
      licenseMode: 'educational',
      bankAccount: 'HDFC Bank — 1234',
      bankAfterBatch: 500000,
    });
    expect(result.generated.transactions[1].description).toContain('On 02-May-2025');
    expect(result.generated.transactions[2].description).toContain('On 31-May-2025');
  });

  it('dates the set-off on the 2nd, after the payment, for educational learners in a 30-day month and February', () => {
    for (const month of [
      { monthIndex: 5, year: 2025, label: 'Jun-2025' },
      { monthIndex: 1, year: 2025, label: 'Feb-2025' },
      { monthIndex: 1, year: 2028, label: 'Feb-2028' },
    ]) {
      const result = appendMonthEndJournals(batch, {
        priorKeys,
        concepts: ['gst_set_off', 'gst_payment'],
        month,
        licenseMode: 'educational',
        bankAccount: 'HDFC Bank — 1234',
        bankAfterBatch: 500000,
      });
      const [, payment, setOff] = result.generated.transactions;
      expect(payment.description).toContain(`On 02-${month.label}`);
      expect(payment.description).toContain('pay the GST liability');
      expect(setOff.description).toContain(`On 02-${month.label}`);
      expect(setOff.description).toContain('set-off');
      expect(payment.sequence).toBeLessThan(setOff.sequence);
    }
  });

  it('keeps the real month end for licensed learners in a 30-day month and a leap February', () => {
    const june = appendMonthEndJournals(batch, {
      priorKeys,
      concepts: ['gst_set_off'],
      month: { monthIndex: 5, year: 2025 },
      licenseMode: 'licensed',
      bankAccount: 'HDFC Bank — 1234',
      bankAfterBatch: 500000,
    });
    expect(june.generated.transactions[1].description).toContain('On 30-Jun-2025');
    const leapFebruary = appendMonthEndJournals(batch, {
      priorKeys,
      concepts: ['gst_set_off'],
      month: { monthIndex: 1, year: 2024 },
      licenseMode: 'licensed',
      bankAccount: 'HDFC Bank — 1234',
      bankAfterBatch: 500000,
    });
    expect(leapFebruary.generated.transactions[1].description).toContain('On 29-Feb-2024');
  });

  it('keeps a reverse-charge journal, which touches both GST sides but is a transaction of the month, not the set-off', () => {
    const withRcm: GeneratedExercise = {
      ...batch,
      transactions: [...batch.transactions, { sequence: 3, description: 'On 12-May-2025, GTA freight under reverse charge.' }],
      answer_key: {
        entries: [
          ...batch.answer_key.entries,
          leg(3, 'Input CGST RCM', 'Dr', 450, { voucher_type: 'Journal', gst_head: 'CGST', gst_rate: 5 }),
          leg(3, 'Input SGST RCM', 'Dr', 450, { voucher_type: 'Journal', gst_head: 'SGST', gst_rate: 5 }),
          leg(3, 'Output CGST RCM', 'Cr', 450, { voucher_type: 'Journal', gst_head: 'CGST', gst_rate: 5 }),
          leg(3, 'Output SGST RCM', 'Cr', 450, { voucher_type: 'Journal', gst_head: 'SGST', gst_rate: 5 }),
        ],
      },
    };
    const result = appendMonthEndJournals(withRcm, {
      priorKeys,
      concepts: ['gst_set_off'],
      month: { monthIndex: 4, year: 2025 },
      licenseMode: 'licensed',
      bankAccount: 'HDFC Bank — 1234',
      bankAfterBatch: 500000,
    });
    // The model's own set-off (sequence 2) is dropped, the RCM journal is
    // kept and renumbered to 2, the computed set-off is appended as 3.
    expect(result.generated.transactions.map((t) => t.description)).toEqual([
      batch.transactions[0].description,
      'On 12-May-2025, GTA freight under reverse charge.',
      expect.stringContaining('On 31-May-2025'),
    ]);
    expect(result.generated.answer_key.entries.filter((e) => e.sequence === 2).map((e) => e.correct_account)).toEqual([
      'Input CGST RCM',
      'Input SGST RCM',
      'Output CGST RCM',
      'Output SGST RCM',
    ]);
  });

  it('leaves a batch alone when neither concept is in play', () => {
    const untouched = appendMonthEndJournals(batch, {
      priorKeys,
      concepts: ['sales_voucher_basics'],
      month: { monthIndex: 4, year: 2025 },
      licenseMode: 'licensed',
      bankAccount: 'HDFC Bank — 1234',
      bankAfterBatch: 500000,
    });
    expect(untouched.generated).toBe(batch);
  });
});

describe('least-cash set-off within Rule 88A (2026-09-17 audit)', () => {
  it('pays nothing on output CGST 100 + SGST 100 against credit IGST 100 + CGST 100 (the greedy order paid 100)', () => {
    const best = optimiseSetOff({ IGST: 0, CGST: 100, SGST: 100 }, { IGST: 100, CGST: 100, SGST: 0 });
    expect(best.cash).toBe(0);
    expect(best.utilisation.IGST.SGST).toBe(100);
    expect(best.utilisation.CGST.CGST).toBe(100);
    const setOff = buildGstSetOff({ ...emptyGstPosition(), output: { IGST: 0, CGST: 100, SGST: 100 }, input: { IGST: 100, CGST: 100, SGST: 0 } });
    expect(setOff?.legs.some((leg) => leg.account === 'GST Payable')).toBe(false);
    expect(setOff?.after.input).toEqual({ IGST: 0, CGST: 0, SGST: 0 });
  });

  it('never uses CGST credit against SGST output', () => {
    const best = optimiseSetOff({ IGST: 0, CGST: 0, SGST: 500 }, { IGST: 0, CGST: 500, SGST: 0 });
    expect(best.cash).toBe(500);
    expect(best.utilisation.CGST.SGST).toBe(0);
  });

  it('uses IGST credit against IGST output first, and CGST/SGST credit against IGST only after', () => {
    const best = optimiseSetOff({ IGST: 1000, CGST: 0, SGST: 0 }, { IGST: 400, CGST: 300, SGST: 300 });
    expect(best.utilisation.IGST.IGST).toBe(400);
    expect(best.utilisation.CGST.IGST + best.utilisation.SGST.IGST).toBe(600);
    expect(best.cash).toBe(0);
  });
});

describe('reverse-charge tax is paid in cash (s. 49(4) and s. 2(82) CGST Act; 2026-09-17 audit)', () => {
  const rcmJournal = (sequence: number): AnswerKeyEntry[] => [
    leg(sequence, 'Input CGST RCM', 'Dr', 450, { voucher_type: 'Journal', gst_head: 'CGST', gst_rate: 2.5 }),
    leg(sequence, 'Input SGST RCM', 'Dr', 450, { voucher_type: 'Journal', gst_head: 'SGST', gst_rate: 2.5 }),
    leg(sequence, 'Output CGST RCM', 'Cr', 450, { voucher_type: 'Journal', gst_head: 'CGST', gst_rate: 2.5 }),
    leg(sequence, 'Output SGST RCM', 'Cr', 450, { voucher_type: 'Journal', gst_head: 'SGST', gst_rate: 2.5 }),
  ];

  it('moves RCM output to GST Payable in full instead of setting it off, and keeps the month RCM credit for next month', () => {
    const batch: GeneratedExercise = {
      scenario: 'Batch.',
      difficulty_level: 'L2',
      variant: 'A',
      transactions: [
        { sequence: 1, description: 'On 05-May-2025, bought goods.' },
        { sequence: 2, description: 'On 12-May-2025, GTA freight under reverse charge.' },
      ],
      answer_key: {
        entries: [
          leg(1, 'Purchases', 'Dr', 10000, { voucher_type: 'Purchase' }),
          leg(1, 'Input CGST', 'Dr', 900, { voucher_type: 'Purchase', gst_head: 'CGST', gst_rate: 9 }),
          leg(1, 'Input SGST', 'Dr', 900, { voucher_type: 'Purchase', gst_head: 'SGST', gst_rate: 9 }),
          leg(1, 'Mumbai Suppliers', 'Cr', 11800, { voucher_type: 'Purchase' }),
          ...rcmJournal(2),
        ],
      },
    };
    const result = appendMonthEndJournals(batch, {
      priorKeys: [],
      concepts: ['gst_set_off'],
      month: { monthIndex: 4, year: 2025 },
      licenseMode: 'licensed',
      bankAccount: 'HDFC Bank — 1234',
      bankAfterBatch: 500000,
    });
    const setOff = result.generated.answer_key.entries
      .filter((entry) => entry.sequence === 3)
      .map((entry) => [entry.correct_account, entry.dr_cr, entry.amount]);
    // No regular output to set off; the RCM tax goes to the payable, and the
    // input RCM credit is not utilised (its tax is unpaid).
    expect(setOff).toEqual([
      ['Output CGST RCM', 'Dr', 450],
      ['Output SGST RCM', 'Dr', 450],
      ['GST Payable', 'Cr', 900],
    ]);
  });

  it('utilises RCM credit from an earlier month once its tax has been paid', () => {
    const position = { ...emptyGstPosition(), output: { IGST: 0, CGST: 1000, SGST: 1000 }, rcmInput: { IGST: 0, CGST: 450, SGST: 450 } };
    const withoutEligibility = buildGstSetOff(position);
    expect(withoutEligibility?.legs.find((leg) => leg.account === 'GST Payable')?.amount).toBe(2000);
    const eligible = buildGstSetOff(position, { eligibleRcmInput: { IGST: 0, CGST: 450, SGST: 450 } });
    expect(eligible?.legs).toContainEqual({ account: 'Input CGST RCM', dr_cr: 'Cr', amount: 450 });
    expect(eligible?.legs.find((leg) => leg.account === 'GST Payable')?.amount).toBe(1100);
  });

  it('uses per-head payable ledgers when the company keeps them', () => {
    const setOff = buildGstSetOff({ ...emptyGstPosition(), output: { IGST: 300, CGST: 100, SGST: 100 } }, { perHeadPayable: true });
    expect(setOff?.legs.filter((leg) => leg.dr_cr === 'Cr')).toEqual([
      { account: 'IGST Payable', dr_cr: 'Cr', amount: 300 },
      { account: 'CGST Payable', dr_cr: 'Cr', amount: 100 },
      { account: 'SGST Payable', dr_cr: 'Cr', amount: 100 },
    ]);
  });
});

describe('a GST payment the bank cannot fund is signalled, not skipped (2026-09-17 audit)', () => {
  it('appends the payment and reports the shortfall', () => {
    const batch: GeneratedExercise = {
      scenario: 'Batch.',
      difficulty_level: 'L2',
      variant: 'A',
      transactions: [{ sequence: 1, description: 'On 05-Jul-2024, sold goods.' }],
      answer_key: { entries: [leg(1, 'Cash', 'Dr', 1000), leg(1, 'Sales', 'Cr', 1000)] },
    };
    const result = appendMonthEndJournals(batch, {
      priorKeys: [{ opening_balances: [{ account: 'GST Payable', dr_cr: 'Cr', amount: 40000 }], entries: [] }],
      concepts: ['gst_payment'],
      month: { monthIndex: 6, year: 2024 },
      licenseMode: 'licensed',
      bankAccount: 'HDFC Bank — 1234',
      bankAfterBatch: 1000,
    });
    expect(result.appended.payment).toBe(true);
    expect(result.paymentShortfall).toEqual({ payable: 40000, bank: 1000 });
  });
});
