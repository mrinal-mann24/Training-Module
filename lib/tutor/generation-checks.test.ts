import { describe, expect, it } from 'vitest';
import type { AnswerKey, AnswerKeyEntry, GeneratedExercise } from '@/lib/schemas/exercise';
import {
  billTokensIn,
  checkBillNumberUniqueness,
  checkConceptTagsMatchContent,
  checkPlaceOfSupply,
  checkReverseCharge,
  checkTextMatchesKey,
  looksLikeDate,
  normalizeDocumentNumber,
  checkGstArithmetic,
  checkGstHeadMetadata,
  checkTdsArithmetic,
  checkTdsThresholds,
  inferTdsSection,
  perHeadFraction,
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

describe('gst_rate conventions (2026-09-11: live keys store the per-head rate, the pack the combined rate)', () => {
  it('reads 9 on a CGST leg as 9% and 18 as 9%, and IGST as the whole rate either way', () => {
    expect(perHeadFraction('CGST', 9)).toBe(0.09);
    expect(perHeadFraction('SGST', 18)).toBe(0.09);
    expect(perHeadFraction('CGST', 2.5)).toBe(0.025);
    expect(perHeadFraction('IGST', 18)).toBe(0.18);
    expect(perHeadFraction('IGST', 9)).toBe(0.18);
    expect(perHeadFraction('CGST', 7)).toBeNull();
  });

  it('accepts a correct intra-state purchase written with the per-head rate and rejects one halved to fit the old reading', () => {
    const perHead = exercise([
      leg(1, 'Purchases', 'Dr', 50000),
      leg(1, 'Input CGST', 'Dr', 4500, { gst_head: 'CGST', gst_rate: 9 }),
      leg(1, 'Input SGST', 'Dr', 4500, { gst_head: 'SGST', gst_rate: 9 }),
      leg(1, 'Mumbai Suppliers', 'Cr', 59000, { bill_reference: 'MS-501' }),
    ]);
    expect(checkGstArithmetic(perHead)).toBeNull();
    const halved = exercise([
      leg(1, 'Purchases', 'Dr', 50000),
      leg(1, 'Input CGST', 'Dr', 2250, { gst_head: 'CGST', gst_rate: 9 }),
      leg(1, 'Input SGST', 'Dr', 2250, { gst_head: 'SGST', gst_rate: 9 }),
      leg(1, 'Mumbai Suppliers', 'Cr', 54500, { bill_reference: 'MS-502' }),
    ]);
    expect(checkGstArithmetic(halved)).toContain('should be 4500');
  });
});

describe('gst_head metadata agrees with the ledger name', () => {
  it('rejects a GST leg with no head or the wrong head, and accepts one that matches', () => {
    const missing = exercise([
      leg(1, 'Purchases', 'Dr', 50000),
      leg(1, 'Input IGST', 'Dr', 9000, { gst_rate: 18 }),
      leg(1, 'Mumbai Suppliers', 'Cr', 59000, { bill_reference: 'MS-503' }),
    ]);
    expect(checkGstHeadMetadata(missing)).toContain('"Input IGST" must carry gst_head "IGST"');
    const wrong = exercise([leg(1, 'Output CGST', 'Cr', 900, { voucher_type: 'Sales', gst_head: 'IGST', gst_rate: 9 })]);
    expect(checkGstHeadMetadata(wrong)).toContain('it says "IGST"');
    const fine = exercise([
      leg(1, 'Input CGST', 'Dr', 4500, { gst_head: 'CGST', gst_rate: 9 }),
      leg(1, 'GST Payable', 'Cr', 4500),
    ]);
    expect(checkGstHeadMetadata(fine)).toBeNull();
  });
});

describe('TDS arithmetic', () => {
  it('requires the TDS leg to equal tds_base x tds_rate and leaves a deposit without a stated base alone', () => {
    const wrong = exercise([
      leg(1, 'Legal & Professional Charges', 'Dr', 60000, { tds_section: '194J', tds_rate: 10, tds_base: 60000 }),
      leg(1, 'TDS Payable — u/s 194J', 'Cr', 1200),
      leg(1, 'Mehta & Associates', 'Cr', 58800, { bill_reference: 'MA-301' }),
    ]);
    expect(checkTdsArithmetic(wrong)).toContain('gives 6000');
    const right = exercise([
      leg(1, 'Legal & Professional Charges', 'Dr', 60000, { tds_section: '194J', tds_rate: 10, tds_base: 60000 }),
      leg(1, 'TDS Payable — u/s 194J', 'Cr', 6000),
      leg(1, 'Mehta & Associates', 'Cr', 54000, { bill_reference: 'MA-302' }),
    ]);
    expect(checkTdsArithmetic(right)).toBeNull();
    const deposit = exercise([
      leg(1, 'TDS Payable — u/s 194J', 'Dr', 6000, { voucher_type: 'Payment' }),
      leg(1, 'HDFC Bank — 1234', 'Cr', 6000, { voucher_type: 'Payment' }),
    ]);
    expect(checkTdsArithmetic(deposit)).toBeNull();
  });
});

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

  it('accepts a correct multi-rate invoice (checked through the taxable values its legs imply since 2026-09-17)', () => {
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

// ---------------------------------------------------------------- 2026-09-17 audit

function dated(entries: AnswerKeyEntry[], descriptions: Record<number, string>): GeneratedExercise {
  const base = exercise(entries);
  return { ...base, transactions: base.transactions.map((t) => ({ ...t, description: descriptions[t.sequence] ?? t.description })) };
}

describe('GST arithmetic no longer skips what it cannot read (2026-09-17 audit)', () => {
  it('rejects a rate GST does not have instead of skipping it', () => {
    const odd = exercise([
      leg(1, 'Purchases', 'Dr', 50000),
      leg(1, 'Input CGST', 'Dr', 3500, { gst_head: 'CGST', gst_rate: 7 }),
      leg(1, 'Input SGST', 'Dr', 3500, { gst_head: 'SGST', gst_rate: 7 }),
      leg(1, 'Deccan Traders', 'Cr', 57000, { bill_reference: 'DT-900' }),
    ]);
    expect(checkGstArithmetic(odd)).toContain('is not a GST rate');
  });

  it('requires CGST to equal SGST', () => {
    const lopsided = exercise([
      leg(1, 'Purchases', 'Dr', 50000),
      leg(1, 'Input CGST', 'Dr', 4500, { gst_head: 'CGST', gst_rate: 9 }),
      leg(1, 'Input SGST', 'Dr', 4000, { gst_head: 'SGST', gst_rate: 9 }),
      leg(1, 'Deccan Traders', 'Cr', 58500, { bill_reference: 'DT-901' }),
    ]);
    expect(checkGstArithmetic(lopsided)).toContain('CGST 4500 and SGST 4000 differ');
  });

  it('checks a multi-rate invoice through the taxable values its legs imply', () => {
    const wrong = exercise([
      leg(1, 'Mysore Decor', 'Dr', 47200, { voucher_type: 'Sales' }),
      leg(1, 'Sales', 'Cr', 40000, { voucher_type: 'Sales' }),
      leg(1, 'Output CGST', 'Cr', 2700, { voucher_type: 'Sales', gst_head: 'CGST', gst_rate: 18 }),
      leg(1, 'Output SGST', 'Cr', 2700, { voucher_type: 'Sales', gst_head: 'SGST', gst_rate: 18 }),
      leg(1, 'Output CGST', 'Cr', 900, { voucher_type: 'Sales', gst_head: 'CGST', gst_rate: 12 }),
      leg(1, 'Output SGST', 'Cr', 900, { voucher_type: 'Sales', gst_head: 'SGST', gst_rate: 12 }),
    ]);
    expect(checkGstArithmetic(wrong)).toContain('imply taxable values totalling 45000');
  });

  it('checks GST legs on a payment voucher too', () => {
    const bankCharges = exercise([
      leg(1, 'Bank Charges', 'Dr', 1000, { voucher_type: 'Payment' }),
      leg(1, 'Input CGST', 'Dr', 180, { voucher_type: 'Payment', gst_head: 'CGST', gst_rate: 9 }),
      leg(1, 'Input SGST', 'Dr', 90, { voucher_type: 'Payment', gst_head: 'SGST', gst_rate: 9 }),
      leg(1, 'HDFC Bank — 1234', 'Cr', 1270, { voucher_type: 'Payment' }),
    ]);
    // "Bank Charges" is the base here; the legs are 18% and 9% of it.
    expect(checkGstArithmetic(bankCharges)).toContain('differ');
  });

  it('rejects IGST and CGST on one invoice', () => {
    const mixed = exercise([
      leg(1, 'Purchases', 'Dr', 10000),
      leg(1, 'Input IGST', 'Dr', 1800, { gst_head: 'IGST', gst_rate: 18 }),
      leg(1, 'Input CGST', 'Dr', 900, { gst_head: 'CGST', gst_rate: 9 }),
      leg(1, 'Deccan Traders', 'Cr', 12700, { bill_reference: 'DT-902' }),
    ]);
    expect(checkGstArithmetic(mixed)).toContain('either intra-state or inter-state');
  });

  it('checks pack-style metadata GST against the party total', () => {
    const pack = exercise([
      leg(1, 'Legal & Professional Charges', 'Dr', 75000, { gst_head: 'CGST', gst_rate: 18, tds_section: '194J', tds_rate: 10, tds_base: 75000 }),
      leg(1, 'Mehta & Associates', 'Cr', 81000, { gst_head: 'CGST', gst_rate: 18, tds_section: '194J', tds_rate: 10, tds_base: 75000, bill_reference: 'CA26-101' }),
    ]);
    expect(checkGstArithmetic(pack)).toBeNull();
    const off = exercise([
      leg(1, 'Purchases', 'Dr', 50000, { gst_head: 'IGST', gst_rate: 18 }),
      leg(1, 'Mumbai Suppliers', 'Cr', 60000, { gst_head: 'IGST', gst_rate: 18, bill_reference: 'MS-777' }),
    ]);
    expect(checkGstArithmetic(off)).toContain('gives 59000');
  });
});

describe('place of supply for every party (2026-09-17 audit)', () => {
  const stateCodeOf = (party: string) => (/mumbai/i.test(party) ? '27' : '29');
  it('rejects IGST from a Karnataka party and CGST from an out-of-state party, new or known', () => {
    const batch = exercise([
      leg(1, 'Purchases', 'Dr', 10000),
      leg(1, 'Input IGST', 'Dr', 1800, { gst_head: 'IGST', gst_rate: 18 }),
      leg(1, 'Brand New Bengaluru Vendor', 'Cr', 11800, { bill_reference: 'BN-1' }),
      leg(2, 'Purchases', 'Dr', 10000),
      leg(2, 'Input CGST', 'Dr', 900, { gst_head: 'CGST', gst_rate: 9 }),
      leg(2, 'Input SGST', 'Dr', 900, { gst_head: 'SGST', gst_rate: 9 }),
      leg(2, 'Mumbai Suppliers', 'Cr', 11800, { bill_reference: 'MS-778' }),
    ]);
    const message = checkPlaceOfSupply(batch, stateCodeOf);
    expect(message).toContain('transaction 1 charges IGST');
    expect(message).toContain('transaction 2 charges CGST/SGST');
  });

  it('accepts GST that follows the party state', () => {
    const batch = exercise([
      leg(1, 'Purchases', 'Dr', 10000),
      leg(1, 'Input IGST', 'Dr', 1800, { gst_head: 'IGST', gst_rate: 18 }),
      leg(1, 'Mumbai Suppliers', 'Cr', 11800, { bill_reference: 'MS-779' }),
    ]);
    expect(checkPlaceOfSupply(batch, stateCodeOf)).toBeNull();
  });
});

describe('reverse charge on legal services (Notification 13/2017-CT(Rate) entry 2)', () => {
  it('flags GST charged forward by an advocate (the pack\'s Sharma Legal bill), not by a CA firm', () => {
    const legal = exercise([
      leg(1, 'Legal & Professional Charges', 'Dr', 30000, { gst_head: 'CGST', gst_rate: 18 }),
      leg(1, 'Sharma Legal', 'Cr', 35400, { gst_head: 'CGST', gst_rate: 18, bill_reference: 'SL-018' }),
      leg(2, 'Legal & Professional Charges', 'Dr', 75000, { gst_head: 'CGST', gst_rate: 18 }),
      leg(2, 'Mehta & Associates', 'Cr', 88500, { gst_head: 'CGST', gst_rate: 18, bill_reference: 'CA26-101' }),
    ]);
    const message = checkReverseCharge(legal);
    expect(message).toContain('transaction 1');
    expect(message).not.toContain('transaction 2');
  });
});

describe('TDS rate by section, payee and date; base and rounding (2026-09-17 audit)', () => {
  it('rejects a rate that is not the section rate', () => {
    const wrongRate = exercise([
      leg(1, 'Legal & Professional Charges', 'Dr', 60000, { tds_section: '194J', tds_rate: 2, tds_base: 60000 }),
      leg(1, 'TDS Payable — u/s 194J', 'Cr', 1200),
      leg(1, 'Mehta & Associates', 'Cr', 58800, { bill_reference: 'MA-303' }),
    ]);
    expect(checkTdsArithmetic(wrongRate)).toContain('is not the 194J rate');
    const contractor = exercise([
      leg(1, 'Repairs & Maintenance', 'Dr', 50000, { tds_section: '194C', tds_rate: 1, tds_base: 50000 }),
      leg(1, 'TDS Payable — u/s 194C', 'Cr', 500),
      leg(1, 'Balaji Interiors', 'Cr', 49500, { bill_reference: 'BI-100' }),
    ]);
    expect(checkTdsArithmetic(contractor, { payeeTypeOf: () => 'other' })).toContain('(2%)');
    expect(checkTdsArithmetic(contractor, { payeeTypeOf: () => 'individual_huf' })).toBeNull();
  });

  it('applies 194H at 5% before and 2% after 1-Oct-2024', () => {
    const commission = (date: string, rate: number) =>
      dated(
        [
          leg(1, 'Commission', 'Dr', 20000, { tds_section: '194H', tds_rate: rate, tds_base: 20000 }),
          leg(1, 'TDS Payable — u/s 194H', 'Cr', 20000 * rate / 100),
          leg(1, 'Agent Co', 'Cr', 20000 - 20000 * rate / 100, { bill_reference: 'AG-1' }),
        ],
        { 1: `On ${date}, commission bill.` },
      );
    expect(checkTdsArithmetic(commission('15-Sep-2024', 5))).toBeNull();
    expect(checkTdsArithmetic(commission('15-Oct-2024', 5))).toContain('is not the 194H rate');
    expect(checkTdsArithmetic(commission('15-Oct-2024', 2))).toBeNull();
  });

  it('requires tds_base to be the expense excluding GST, and the deduction rounded to the rupee', () => {
    const onGross = exercise([
      leg(1, 'Legal & Professional Charges', 'Dr', 60000, { tds_section: '194J', tds_rate: 10, tds_base: 70800 }),
      leg(1, 'Input CGST', 'Dr', 5400, { gst_head: 'CGST', gst_rate: 9 }),
      leg(1, 'Input SGST', 'Dr', 5400, { gst_head: 'SGST', gst_rate: 9 }),
      leg(1, 'TDS Payable — u/s 194J', 'Cr', 7080),
      leg(1, 'Mehta & Associates', 'Cr', 63720, { bill_reference: 'MA-304' }),
    ]);
    expect(checkTdsArithmetic(onGross)).toContain('TDS is on the value excluding GST');
    const paise = exercise([
      leg(1, 'Legal & Professional Charges', 'Dr', 60005, { tds_section: '194J', tds_rate: 10, tds_base: 60005 }),
      leg(1, 'TDS Payable — u/s 194J', 'Cr', 6000.5),
      leg(1, 'Mehta & Associates', 'Cr', 54004.5, { bill_reference: 'MA-305' }),
    ]);
    expect(checkTdsArithmetic(paise)).toContain('gives 6001');
  });

  it('checks a TDS leg on a supplier-advance Payment the section regex would not infer', () => {
    const advance = exercise([
      leg(1, 'Brightlane Studio', 'Dr', 100000, { voucher_type: 'Payment', bill_reference: 'ADV-S09 (Advance)' }),
      leg(1, 'TDS Payable — u/s 194J', 'Cr', 5000, { voucher_type: 'Payment', tds_section: '194J', tds_rate: 10, tds_base: 100000 }),
      leg(1, 'HDFC Bank — 1234', 'Cr', 95000, { voucher_type: 'Payment' }),
    ]);
    expect(checkTdsArithmetic(advance)).toContain('gives 10000');
  });
});

describe('TDS thresholds by financial year and 194I (2026-09-17 audit)', () => {
  const rent = (date: string, amount: number, withTds: boolean) =>
    dated(
      [
        leg(1, 'Rent', 'Dr', amount, withTds ? { tds_section: '194I', tds_rate: 10, tds_base: amount } : {}),
        ...(withTds ? [leg(1, 'TDS Payable — u/s 194I', 'Cr', amount / 10)] : []),
        leg(1, 'Hero Rentals', 'Cr', withTds ? amount * 0.9 : amount, { bill_reference: 'HR-200' }),
      ],
      { 1: `On ${date}, rent bill from Hero Rentals.` },
    );

  it('accepts the pack\'s own April 2024 rent: 40,000 a month is likely to exceed 2,40,000 (fixes the false rejection)', () => {
    expect(checkTdsThresholds(rent('05-Apr-2024', 40000, true), new Map())).toBeNull();
    expect(checkTdsThresholds(rent('05-Apr-2024', 40000, false), new Map())).toContain('TDS must be deducted');
  });

  it('from FY 2025-26 taxes rent only above 50,000 a month', () => {
    expect(checkTdsThresholds(rent('05-Apr-2025', 40000, true), new Map())).toContain('no TDS applies yet');
    expect(checkTdsThresholds(rent('05-Apr-2025', 60000, true), new Map())).toBeNull();
  });

  it('applies the FY 2025-26 194J threshold of 50,000', () => {
    const fee = (date: string) =>
      dated([leg(1, 'Legal & Professional Charges', 'Dr', 40000), leg(1, 'Mehta & Associates', 'Cr', 40000, { bill_reference: 'MA-400' })], {
        1: `On ${date}, fee bill.`,
      });
    expect(checkTdsThresholds(fee('10-May-2024'), new Map())).toContain('TDS must be deducted');
    expect(checkTdsThresholds(fee('10-May-2025'), new Map())).toBeNull();
  });

  it('reads a direct expense payment and a journal accrual with a TDS leg', () => {
    const direct = exercise([
      leg(1, 'Freight & Delivery Charges', 'Dr', 40000, { voucher_type: 'Payment' }),
      leg(1, 'HDFC Bank — 1234', 'Cr', 40000, { voucher_type: 'Payment' }),
    ]);
    expect(checkTdsThresholds(direct, new Map())).toContain('TDS must be deducted');
    const accrual = exercise([
      leg(1, 'Audit Fees', 'Dr', 10000, { voucher_type: 'Journal', tds_section: '194J', tds_rate: 10, tds_base: 10000 }),
      leg(1, 'TDS Payable — u/s 194J', 'Cr', 1000, { voucher_type: 'Journal' }),
      leg(1, 'Rao & Co', 'Cr', 9000, { voucher_type: 'Journal' }),
    ]);
    expect(checkTdsThresholds(accrual, new Map())).toContain('no TDS applies yet');
  });
});

describe('text and key agree on bill numbers and figures (2026-09-17 audit, CRITICAL)', () => {
  it('reads bill-shaped tokens only', () => {
    expect(billTokensIn('billboard-advertising and inventory-related costs, bill DT-2301 and MS/990, 05-Jun-2024, GSTR-3B')).toEqual(['DT-2301', 'MS/990']);
  });

  it('rejects a line naming a bill the key does not carry', () => {
    const batch = dated(
      [leg(1, 'HDFC Bank — 1234', 'Dr', 23600, { voucher_type: 'Receipt' }), leg(1, 'Delhi Bazaar', 'Cr', 23600, { voucher_type: 'Receipt', bill_reference: 'INV-061' })],
      { 1: 'On 05-Jun-2024, Delhi Bazaar pays Rs 23,600 against INV-062.' },
    );
    expect(checkTextMatchesKey(batch)).toContain('names INV-062');
    const same = dated(
      [leg(1, 'HDFC Bank — 1234', 'Dr', 23600, { voucher_type: 'Receipt' }), leg(1, 'Delhi Bazaar', 'Cr', 23600, { voucher_type: 'Receipt', bill_reference: 'INV-0062' })],
      { 1: 'On 05-Jun-2024, Delhi Bazaar pays Rs 23,600 against INV-062.' },
    );
    expect(checkTextMatchesKey(same)).toBeNull();
  });

  it('rejects a figure in a text line that the key does not carry, and accepts sums and settled balances', () => {
    const wrong = dated(
      [leg(1, 'Purchases', 'Dr', 50000), leg(1, 'Input IGST', 'Dr', 9000, { gst_head: 'IGST', gst_rate: 18 }), leg(1, 'Mumbai Suppliers', 'Cr', 59000, { bill_reference: 'MS-801' })],
      { 1: 'On 05-Jun-2024, bill MS-801 from Mumbai Suppliers for goods Rs 50,000 plus IGST Rs 9,000, total Rs 60,000.' },
    );
    expect(checkTextMatchesKey(wrong)).toContain('Rs 60,000');
    const right = dated(
      [
        leg(1, 'HDFC Bank — 1234', 'Dr', 20000, { voucher_type: 'Receipt' }),
        leg(1, 'Delhi Bazaar', 'Cr', 20000, { voucher_type: 'Receipt', bill_reference: 'INV-003 (part)' }),
      ],
      { 1: 'On 05-Jun-2024, Delhi Bazaar pays Rs 20,000 against INV-003 (Rs 22,000 outstanding), leaving Rs 2,000.' },
    );
    expect(checkTextMatchesKey(right, [{ party: 'Delhi Bazaar', ref: 'INV-003', open: 22000, side: 'receivable' }])).toBeNull();
  });
});

describe('concept tags must match content (2026-09-17 audit)', () => {
  it('rejects tds_classification without TDS and bill_by_bill without a reference', () => {
    const batch = exercise([
      leg(1, 'Electricity Charges', 'Dr', 5000, { concept_tags: ['tds_classification', 'purchase_voucher_basics'] }),
      leg(1, 'BESCOM', 'Cr', 5000, { concept_tags: ['bill_by_bill_referencing'] }),
    ]);
    const message = checkConceptTagsMatchContent(batch);
    expect(message).toContain('tagged tds_classification but lacks a TDS leg');
    expect(message).toContain('bill_by_bill_referencing');
    expect(message).not.toContain('purchase_voucher_basics');
  });
});

describe('document numbers (2026-09-17 audit)', () => {
  it('treats INV-18 and INV-018 as the same number, and counts advances, credit notes and debit notes', () => {
    expect(normalizeDocumentNumber('INV-018')).toBe(normalizeDocumentNumber('INV-18'));
    const prior = priorBillReferences([
      {
        entries: [
          leg(1, 'Delhi Bazaar', 'Dr', 11800, { voucher_type: 'Sales', bill_reference: 'INV-018' }),
          leg(1, 'Sales', 'Cr', 10000, { voucher_type: 'Sales' }),
          leg(2, 'HDFC Bank — 1234', 'Dr', 5000, { voucher_type: 'Receipt' }),
          leg(2, 'Kochi Modern', 'Cr', 5000, { voucher_type: 'Receipt', bill_reference: 'ADV-C07 (Advance)' }),
          leg(3, 'Sales Returns', 'Dr', 1000, { voucher_type: 'Credit Note' }),
          leg(3, 'Delhi Bazaar', 'Cr', 1180, { voucher_type: 'Credit Note', bill_reference: 'CN-004, Against INV-018' }),
        ],
      },
    ]);
    expect(prior).toEqual(new Set(['inv18', 'advc7', 'cn4']));
    const reuse = exercise([
      leg(1, 'Kolkata Emporium', 'Dr', 1180, { voucher_type: 'Sales', bill_reference: 'INV-18' }),
      leg(1, 'Sales', 'Cr', 1000, { voucher_type: 'Sales' }),
      leg(2, 'HDFC Bank — 1234', 'Dr', 500, { voucher_type: 'Receipt' }),
      leg(2, 'Nagpur Retail', 'Cr', 500, { voucher_type: 'Receipt', bill_reference: 'ADV-C7 (Advance)' }),
      leg(3, 'Purchase Returns', 'Cr', 1000, { voucher_type: 'Debit Note' }),
      leg(3, 'Mumbai Suppliers', 'Dr', 1180, { voucher_type: 'Debit Note', bill_reference: 'CN-4' }),
    ]);
    const message = checkBillNumberUniqueness(reuse, prior);
    expect(message).toContain('INV-18, which an earlier month already used');
    expect(message).toContain('ADV-C7');
    // A note naming a number already raised reads it as the note it is against, so it has no own number.
    expect(message).toContain('transaction 3 is a credit Debit Note');
  });

  it('requires an own number on every credit sale, purchase and note, but not on a cash sale', () => {
    const batch = exercise([
      leg(1, 'Delhi Bazaar', 'Dr', 1180, { voucher_type: 'Sales' }),
      leg(1, 'Sales', 'Cr', 1000, { voucher_type: 'Sales' }),
      leg(2, 'Sales Returns', 'Dr', 1000, { voucher_type: 'Credit Note' }),
      leg(2, 'Delhi Bazaar', 'Cr', 1180, { voucher_type: 'Credit Note', bill_reference: 'INV-3001' }),
      leg(3, 'Cash', 'Dr', 590, { voucher_type: 'Sales' }),
      leg(3, 'Sales', 'Cr', 500, { voucher_type: 'Sales' }),
    ]);
    const message = checkBillNumberUniqueness(batch, new Set(['inv3001']));
    expect(message).toContain('transaction 1 is a credit Sales');
    expect(message).toContain('transaction 2 is a credit Credit Note');
    expect(message).not.toContain('transaction 3');
  });

  it('rejects a document number shaped like a date', () => {
    const batch = exercise([
      leg(1, 'Mysore Decor', 'Dr', 1180, { voucher_type: 'Sales', bill_reference: 'MS/12/06/2024' }),
      leg(1, 'Sales', 'Cr', 1000, { voucher_type: 'Sales' }),
    ]);
    expect(checkBillNumberUniqueness(batch, new Set())).toContain('shaped like a date');
    expect(looksLikeDate('INV-12-Jun-2024')).toBe(true);
    expect(looksLikeDate('CA26-101')).toBe(false);
  });
});
