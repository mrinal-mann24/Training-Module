import { describe, expect, it } from 'vitest';
import type { AnswerKey, AnswerKeyEntry, GeneratedExercise } from '@/lib/schemas/exercise';
import {
  checkBillNumberUniqueness,
  checkGstArithmetic,
  checkTdsThresholds,
  inferTdsSection,
  priorBillReferences,
  tdsHistoryFromKeys,
} from './generation-checks';

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

function exercise(entries: AnswerKeyEntry[]): GeneratedExercise {
  const sequences = [...new Set(entries.map((entry) => entry.sequence))];
  return {
    scenario: 'Batch.',
    difficulty_level: 'L2',
    variant: 'A',
    transactions: sequences.map((sequence) => ({ sequence, description: `Transaction ${sequence}` })),
    answer_key: { entries },
  };
}

describe('bill numbers are unique across the year (Yeshas, June: INV-024 reused)', () => {
  const earlier: AnswerKey = {
    entries: [
      leg(1, 'Karnataka Emporium', 'Dr', 11800, { voucher_type: 'Sales', bill_reference: 'INV-024 (New Ref)' }),
      leg(1, 'Sales', 'Cr', 10000, { voucher_type: 'Sales' }),
    ],
  };

  it('collects the numbers raised so far and rejects a reuse', () => {
    const prior = priorBillReferences([earlier]);
    expect(prior.has('inv024') || prior.size === 1).toBe(true);
    const reused = exercise([
      leg(1, 'Delhi Bazaar', 'Dr', 23600, { voucher_type: 'Sales', bill_reference: 'INV-024' }),
      leg(1, 'Sales', 'Cr', 20000, { voucher_type: 'Sales' }),
    ]);
    expect(checkBillNumberUniqueness(reused, prior)).toContain('INV-024');
    const fresh = exercise([
      leg(1, 'Delhi Bazaar', 'Dr', 23600, { voucher_type: 'Sales', bill_reference: 'INV-041' }),
      leg(1, 'Sales', 'Cr', 20000, { voucher_type: 'Sales' }),
    ]);
    expect(checkBillNumberUniqueness(fresh, prior)).toBeNull();
  });

  it('rejects the same number raised twice in one batch, but not a settlement against it', () => {
    const twice = exercise([
      leg(1, 'Delhi Bazaar', 'Dr', 23600, { voucher_type: 'Sales', bill_reference: 'INV-041' }),
      leg(1, 'Sales', 'Cr', 20000, { voucher_type: 'Sales' }),
      leg(2, 'Kolkata Emporium', 'Dr', 5900, { voucher_type: 'Sales', bill_reference: 'INV-041' }),
      leg(2, 'Sales', 'Cr', 5000, { voucher_type: 'Sales' }),
      leg(3, 'HDFC Bank — 1234', 'Dr', 23600, { voucher_type: 'Receipt' }),
      leg(3, 'Delhi Bazaar', 'Cr', 23600, { voucher_type: 'Receipt', bill_reference: 'Against INV-041' }),
    ]);
    expect(checkBillNumberUniqueness(twice, new Set())).toContain('twice');
  });
});

describe('GST arithmetic (Garima, May: 10% a side on a 50,000 purchase)', () => {
  it('rejects GST legs that do not equal base times rate', () => {
    const wrong = exercise([
      leg(1, 'Purchases', 'Dr', 50000),
      leg(1, 'Input CGST', 'Dr', 5000, { gst_head: 'CGST', gst_rate: 18 }),
      leg(1, 'Input SGST', 'Dr', 5000, { gst_head: 'SGST', gst_rate: 18 }),
      leg(1, 'Deccan Traders', 'Cr', 60000),
    ]);
    const message = checkGstArithmetic(wrong);
    expect(message).toContain('CGST is 5000');
    expect(message).toContain('should be 4500');
  });

  it('accepts correct intra-state, inter-state and credit-note figures', () => {
    const right = exercise([
      leg(1, 'Purchases', 'Dr', 50000),
      leg(1, 'Input CGST', 'Dr', 4500, { gst_head: 'CGST', gst_rate: 18 }),
      leg(1, 'Input SGST', 'Dr', 4500, { gst_head: 'SGST', gst_rate: 18 }),
      leg(1, 'Deccan Traders', 'Cr', 59000),
      leg(2, 'Delhi Bazaar', 'Dr', 118000, { voucher_type: 'Sales' }),
      leg(2, 'Sales', 'Cr', 100000, { voucher_type: 'Sales' }),
      leg(2, 'Output IGST', 'Cr', 18000, { voucher_type: 'Sales', gst_head: 'IGST', gst_rate: 18 }),
      leg(3, 'Sales Returns', 'Dr', 10000, { voucher_type: 'Credit Note' }),
      leg(3, 'Output IGST', 'Dr', 1800, { voucher_type: 'Credit Note', gst_head: 'IGST', gst_rate: 18 }),
      leg(3, 'Delhi Bazaar', 'Cr', 11800, { voucher_type: 'Credit Note' }),
    ]);
    expect(checkGstArithmetic(right)).toBeNull();
  });

  it('leaves a multi-rate invoice alone', () => {
    const multiRate = exercise([
      leg(1, 'Mysore Decor', 'Dr', 46600, { voucher_type: 'Sales' }),
      leg(1, 'Sales', 'Cr', 40000, { voucher_type: 'Sales' }),
      leg(1, 'Output CGST', 'Cr', 2700, { voucher_type: 'Sales', gst_head: 'CGST', gst_rate: 18 }),
      leg(1, 'Output SGST', 'Cr', 2700, { voucher_type: 'Sales', gst_head: 'SGST', gst_rate: 18 }),
      leg(1, 'Output CGST', 'Cr', 600, { voucher_type: 'Sales', gst_head: 'CGST', gst_rate: 12 }),
      leg(1, 'Output SGST', 'Cr', 600, { voucher_type: 'Sales', gst_head: 'SGST', gst_rate: 12 }),
    ]);
    expect(checkGstArithmetic(multiRate)).toBeNull();
  });
});

describe('TDS thresholds across the year (rulebook 12.4; Praveen, April 2025)', () => {
  it('infers the section from the expense ledger', () => {
    expect(inferTdsSection('Rent')).toBe('194I');
    expect(inferTdsSection('Legal & Professional Charges')).toBe('194J');
    expect(inferTdsSection('Advertisement & Marketing')).toBe('194C');
    expect(inferTdsSection('Commission')).toBe('194H');
    expect(inferTdsSection('Electricity Charges')).toBeNull();
  });

  it('rejects TDS deducted on the first 25,000 advertising bill of the year', () => {
    const batch = exercise([
      leg(1, 'Advertisement & Marketing', 'Dr', 25000, { tds_section: '194C', tds_rate: 2, tds_base: 25000 }),
      leg(1, 'Input CGST', 'Dr', 2250, { gst_head: 'CGST', gst_rate: 18 }),
      leg(1, 'Input SGST', 'Dr', 2250, { gst_head: 'SGST', gst_rate: 18 }),
      leg(1, 'TDS Payable — u/s 194C', 'Cr', 500),
      leg(1, 'Signage Advertising', 'Cr', 29000),
    ]);
    expect(checkTdsThresholds(batch, new Map())).toContain('no TDS applies yet');
  });

  it('requires TDS once the running total crosses the threshold, counting earlier months', () => {
    const earlier: AnswerKey = {
      entries: [
        leg(1, 'Legal & Professional Charges', 'Dr', 30000),
        leg(1, 'Sharma Legal', 'Cr', 30000),
      ],
    };
    const history = tdsHistoryFromKeys([earlier]);
    const missing = exercise([
      leg(1, 'Legal & Professional Charges', 'Dr', 30000),
      leg(1, 'Sharma Legal', 'Cr', 30000),
    ]);
    expect(checkTdsThresholds(missing, history)).toContain('TDS must be deducted');
    const deducted = exercise([
      leg(1, 'Legal & Professional Charges', 'Dr', 30000, { tds_section: '194J', tds_rate: 10, tds_base: 30000 }),
      leg(1, 'TDS Payable — u/s 194J', 'Cr', 3000),
      leg(1, 'Sharma Legal', 'Cr', 27000),
    ]);
    expect(checkTdsThresholds(deducted, history)).toBeNull();
  });

  it('applies the single-bill rule for contractors', () => {
    const single = exercise([
      leg(1, 'Repairs & Maintenance', 'Dr', 35000, { tds_section: '194C', tds_rate: 2, tds_base: 35000 }),
      leg(1, 'TDS Payable — u/s 194C', 'Cr', 700),
      leg(1, 'Balaji Interiors', 'Cr', 34300),
    ]);
    expect(checkTdsThresholds(single, new Map())).toBeNull();
  });

  it('ignores goods purchases and expense ledgers with no TDS section', () => {
    const goods = exercise([
      leg(1, 'Purchases', 'Dr', 300000),
      leg(1, 'Mumbai Suppliers', 'Cr', 300000),
      leg(2, 'Electricity Charges', 'Dr', 300000),
      leg(2, 'BESCOM', 'Cr', 300000),
    ]);
    expect(checkTdsThresholds(goods, new Map())).toBeNull();
  });
});
