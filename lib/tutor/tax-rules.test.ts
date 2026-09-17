import { describe, expect, it } from 'vitest';
import {
  allowedGstRates,
  effectiveTdsRate,
  financialYearOf,
  gstSplit,
  inferPayeeType,
  inferTdsNature,
  inferTdsSectionFromLedger,
  isAllowedGstRate,
  isTdsRequired,
  reverseChargeCategoryFor,
  roundTdsAmount,
  taxRulesSummaryFor,
  tdsRatesFor,
  tdsSectionFromText,
  tdsThresholdFor,
} from './tax-rules';

const d = (day: number, month: number, year: number) => ({ day, monthIndex: month - 1, year });

describe('financialYearOf', () => {
  it('starts the year on 1 April', () => {
    expect(financialYearOf(d(31, 3, 2025)).label).toBe('2024-25');
    expect(financialYearOf(d(1, 4, 2025)).label).toBe('2025-26');
  });
});

describe('TDS rates by section, payee and date (Income-tax Act ss. 194C/194H/194I/194J/206AA)', () => {
  it('194C: 1% individual/HUF, 2% others, both when the constitution is unknown', () => {
    expect(tdsRatesFor('194C', d(10, 5, 2024), { payeeType: 'individual_huf' })).toEqual([1]);
    expect(tdsRatesFor('194C', d(10, 5, 2024), { payeeType: 'other' })).toEqual([2]);
    expect(tdsRatesFor('194C', d(10, 5, 2024))).toEqual([1, 2]);
  });

  it('194J: 10% professional, 2% technical', () => {
    expect(tdsRatesFor('194J', d(10, 5, 2024), { nature: 'professional' })).toEqual([10]);
    expect(tdsRatesFor('194J', d(10, 5, 2024), { nature: 'technical' })).toEqual([2]);
  });

  it('194I: 10% land/building, 2% plant and machinery', () => {
    expect(tdsRatesFor('194I', d(10, 5, 2024), { nature: 'land_building' })).toEqual([10]);
    expect(tdsRatesFor('194I', d(10, 5, 2024), { nature: 'plant_machinery' })).toEqual([2]);
  });

  it('194H: 5% until 30-Sep-2024, 2% from 1-Oct-2024 (Finance (No. 2) Act 2024)', () => {
    expect(tdsRatesFor('194H', d(30, 9, 2024))).toEqual([5]);
    expect(tdsRatesFor('194H', d(1, 10, 2024))).toEqual([2]);
  });

  it('206AA: 20% when the PAN is missing, or the section rate if higher', () => {
    expect(effectiveTdsRate(2, false)).toBe(20);
    expect(effectiveTdsRate(10, true)).toBe(10);
  });

  it('rounds the deduction to the rupee', () => {
    expect(roundTdsAmount(1234.5)).toBe(1235);
    expect(roundTdsAmount(1234.49)).toBe(1234);
  });
});

describe('TDS thresholds by financial year (Finance Act 2025 changes from 1-Apr-2025)', () => {
  const exposure = (bill: number, fyAggregate = bill, monthAggregate = bill) => ({ bill, fyAggregate, monthAggregate });

  it('194C: single bill exceeds 30,000 or aggregate exceeds 1,00,000; "exceeds" is strict', () => {
    expect(isTdsRequired('194C', d(5, 6, 2024), exposure(30000))).toBe(false);
    expect(isTdsRequired('194C', d(5, 6, 2024), exposure(30001))).toBe(true);
    expect(isTdsRequired('194C', d(5, 6, 2024), exposure(20000, 100000))).toBe(false);
    expect(isTdsRequired('194C', d(5, 6, 2024), exposure(20000, 100001))).toBe(true);
    // The pack's Delivery Direct freight bill of 40,000 needs TDS.
    expect(isTdsRequired('194C', d(15, 4, 2024), exposure(40000))).toBe(true);
  });

  it('194J: 30,000 a year in FY 2024-25, 50,000 from FY 2025-26', () => {
    expect(isTdsRequired('194J', d(5, 6, 2024), exposure(30000))).toBe(false);
    expect(isTdsRequired('194J', d(5, 6, 2024), exposure(35000))).toBe(true);
    expect(isTdsRequired('194J', d(5, 6, 2025), exposure(35000))).toBe(false);
    expect(isTdsRequired('194J', d(5, 6, 2025), exposure(20000, 50001))).toBe(true);
  });

  it('194I FY 2024-25: rent likely to exceed 2,40,000 a year, so Hero Rentals at 40,000 a month is taxed from April', () => {
    expect(tdsThresholdFor('194I', d(5, 4, 2024)).kind).toBe('fy_likely');
    expect(isTdsRequired('194I', d(5, 4, 2024), exposure(40000))).toBe(true);
    expect(isTdsRequired('194I', d(5, 4, 2024), exposure(15000))).toBe(false);
  });

  it('194I FY 2025-26: rent for a month exceeds 50,000', () => {
    expect(isTdsRequired('194I', d(5, 4, 2025), exposure(40000, 440000))).toBe(false);
    expect(isTdsRequired('194I', d(5, 4, 2025), exposure(30000, 30000, 60000))).toBe(true);
  });

  it('194H: 15,000 a year in FY 2024-25, 20,000 from FY 2025-26', () => {
    expect(isTdsRequired('194H', d(5, 6, 2024), exposure(18000))).toBe(true);
    expect(isTdsRequired('194H', d(5, 6, 2025), exposure(18000))).toBe(false);
  });
});

describe('section, nature and payee inference', () => {
  it('reads the section from a ledger name or a tds_section field', () => {
    expect(tdsSectionFromText('TDS Payable — u/s 194J')).toBe('194J');
    expect(tdsSectionFromText('194-I')).toBe('194I');
    expect(tdsSectionFromText('TDS Payable')).toBeNull();
    expect(inferTdsSectionFromLedger('Freight & Delivery Charges')).toBe('194C');
    expect(inferTdsSectionFromLedger('Rent')).toBe('194I');
  });

  it('reads nature and constitution', () => {
    expect(inferTdsNature('194J', ['Legal & Professional Charges'])).toBe('professional');
    expect(inferTdsNature('194J', ['Technical Services'])).toBe('technical');
    expect(inferTdsNature('194I', ['Rent'])).toBe('land_building');
    expect(inferPayeeType('Mehta & Associates')).toBe('other');
    expect(inferPayeeType('Balaji Interiors')).toBe('unknown');
    expect(inferPayeeType('Ramesh Kumar', 'Individual')).toBe('individual_huf');
  });
});

describe('GST rates and split (CGST/IGST Acts; Notification 1/2017 and 9/2025-CT(Rate))', () => {
  it('allows only the notified slabs, with 40% from 22-Sep-2025', () => {
    expect(allowedGstRates(d(1, 5, 2024))).toEqual([0, 0.25, 3, 5, 12, 18, 28]);
    expect(isAllowedGstRate(10, d(1, 5, 2024))).toBe(false);
    expect(isAllowedGstRate(40, d(21, 9, 2025))).toBe(false);
    expect(isAllowedGstRate(40, d(22, 9, 2025))).toBe(true);
  });

  it('splits intra-state tax half and half and charges IGST in full inter-state', () => {
    expect(gstSplit(50000, 18, false)).toEqual({ cgst: 4500, sgst: 4500, igst: 0 });
    expect(gstSplit(50000, 18, true)).toEqual({ cgst: 0, sgst: 0, igst: 9000 });
  });

  it('recognises the reverse-charge categories', () => {
    expect(reverseChargeCategoryFor({ party: 'Sharma Legal', expenseLedgers: ['Legal & Professional Charges'] })?.id).toBe('legal_advocate');
    expect(reverseChargeCategoryFor({ party: 'Mehta & Associates', expenseLedgers: ['Legal & Professional Charges'] })).toBeNull();
    expect(reverseChargeCategoryFor({ party: 'VRL Roadways', expenseLedgers: ['Freight'] })?.mandatory).toBe(false);
  });

  it('writes the rules in force for the prompt', () => {
    const fy24 = taxRulesSummaryFor(d(1, 6, 2024));
    expect(fy24).toContain('FY 2024-25');
    expect(fy24).toContain('Rs 30,000');
    expect(fy24).toContain('194H commission: 5%');
    const fy25 = taxRulesSummaryFor(d(1, 6, 2025));
    expect(fy25).toContain('rent for a month or part of a month over Rs 50,000');
    expect(fy25).toContain('194H commission: 2%');
  });
});
