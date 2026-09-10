import { describe, expect, it } from 'vitest';
import type { AnswerKey, AnswerKeyEntry, GeneratedExercise } from '@/lib/schemas/exercise';
import { appendMonthEndJournals, buildGstSetOff, gstPositionFromKeys } from './month-end-journals';

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
    expect(setOff?.after).toEqual({ output: { IGST: 0, CGST: 0, SGST: 0 }, input: { IGST: 0, CGST: 0, SGST: 0 }, payable: 8500 });
    // The journal balances.
    const dr = setOff!.legs.filter((l) => l.dr_cr === 'Dr').reduce((s, l) => s + l.amount, 0);
    const cr = setOff!.legs.filter((l) => l.dr_cr === 'Cr').reduce((s, l) => s + l.amount, 0);
    expect(dr).toBe(cr);
  });

  it('returns null when there is no output liability', () => {
    expect(buildGstSetOff({ output: { IGST: 0, CGST: 0, SGST: 0 }, input: { IGST: 500, CGST: 0, SGST: 0 }, payable: 0 })).toBeNull();
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
