import { describe, expect, it } from 'vitest';
import type { AnswerKeyEntry } from '@/lib/schemas/exercise';
import { VendorInvoiceContentSchema } from '@/lib/schemas/source-document';
import { buildVendorInvoiceContent } from './build-vendor-invoice';
import { COMPANY_DETAILS } from './company-details';
import { isValidGstin, partyIdentityFor } from './party-directory';

function leg(overrides: Partial<AnswerKeyEntry> & Pick<AnswerKeyEntry, 'correct_account' | 'dr_cr' | 'amount'>): AnswerKeyEntry {
  return {
    sequence: 7,
    voucher_type: 'Purchase',
    gst_head: null,
    gst_rate: null,
    tds_section: null,
    tds_rate: null,
    tds_base: null,
    bill_reference: 'MS/990 (New Ref)',
    narration: null,
    concept_tags: ['purchase_voucher_basics'],
    requires_source_document: true,
    source_document_type: 'vendor_invoice',
    ...overrides,
  };
}

const description = 'On 15-Jun-2025, an invoice arrived from Mumbai Suppliers (Ref MS/990): post it from the attached invoice.';

describe('buildVendorInvoiceContent (every printed fact is the key\'s or the party master\'s)', () => {
  const goodsAndFreight = [
    leg({ correct_account: 'Purchases', dr_cr: 'Dr', amount: 35000 }),
    leg({ correct_account: 'Freight & Delivery Charges', dr_cr: 'Dr', amount: 2000 }),
    leg({ correct_account: 'Input IGST', dr_cr: 'Dr', amount: 6660, gst_head: 'IGST', gst_rate: 18 }),
    leg({ correct_account: 'Mumbai Suppliers', dr_cr: 'Cr', amount: 43660 }),
  ];

  it('prints one line per expense leg, the vendor\'s one identity, and the key\'s figures', () => {
    const content = buildVendorInvoiceContent(goodsAndFreight, description, 'Blossom Retail Pvt Ltd');
    const vendor = partyIdentityFor('Mumbai Suppliers');
    expect(content).toEqual({
      vendorName: 'Mumbai Suppliers',
      vendorGSTIN: vendor.gstin,
      vendorAddress: vendor.address,
      invoiceNumber: 'MS/990',
      invoiceDate: '15-Jun-2025',
      lineItems: [
        { description: 'Trading goods as per order', quantity: 1, rate: 35000, amount: 35000, hsnSac: 'HSN 6304' },
        { description: 'Freight and delivery charges', quantity: 1, rate: 2000, amount: 2000, hsnSac: 'SAC 996511' },
      ],
      taxBreakup: { cgst_amount: null, sgst_amount: null, igst_amount: 6660 },
      totalAmount: 43660,
      buyerName: 'Blossom Retail Pvt Ltd',
      buyerGSTIN: COMPANY_DETAILS.gstin,
      buyerAddress: COMPANY_DETAILS.address,
      placeOfSupply: 'Karnataka',
      placeOfSupplyCode: '29',
      reverseCharge: false,
      taxRatePercent: 18,
      amountInWords: 'Rupees Forty Three Thousand Six Hundred Sixty Only',
    });
    expect(isValidGstin(content.vendorGSTIN)).toBe(true);
    // Maharashtra vendor, IGST on the key: the printed state agrees.
    expect(content.vendorGSTIN.startsWith('27')).toBe(true);
    expect(VendorInvoiceContentSchema.parse(content)).toEqual(content);
  });

  it('prints the plan\'s own lines when they add up to the one goods leg, else one line per leg', () => {
    const goods = [
      leg({ correct_account: 'Purchases', dr_cr: 'Dr', amount: 37000 }),
      leg({ correct_account: 'Input IGST', dr_cr: 'Dr', amount: 6660, gst_head: 'IGST', gst_rate: 18 }),
      leg({ correct_account: 'Mumbai Suppliers', dr_cr: 'Cr', amount: 43660 }),
    ];
    const lines = [
      { description: 'Cotton fabric rolls', quantity: 4, rate: 5000 },
      { description: 'Polyester rolls', quantity: 2, rate: 8500 },
    ];
    expect(buildVendorInvoiceContent(goods, description, undefined, { lines }).lineItems).toEqual([
      { description: 'Cotton fabric rolls', quantity: 4, rate: 5000, amount: 20000, hsnSac: 'HSN 6304' },
      { description: 'Polyester rolls', quantity: 2, rate: 8500, amount: 17000, hsnSac: 'HSN 6304' },
    ]);
    // Lines that do not add up to the leg are not printed.
    expect(buildVendorInvoiceContent(goods, description, undefined, { lines: [lines[0]] }).lineItems).toEqual([
      { description: 'Trading goods as per order', quantity: 1, rate: 37000, amount: 37000, hsnSac: 'HSN 6304' },
    ]);
    // A service bill never splits into the plan's lines.
    expect(buildVendorInvoiceContent(goodsAndFreight, description, undefined, { lines }).lineItems).toHaveLength(2);
  });

  it('prints a TDS bill at the gross fee, with the vendor\'s Karnataka GSTIN beside CGST/SGST', () => {
    const service = [
      leg({ correct_account: 'Legal & Professional Charges', dr_cr: 'Dr', amount: 50000, bill_reference: 'SL/2027-04' }),
      leg({ correct_account: 'Input CGST', dr_cr: 'Dr', amount: 4500, gst_head: 'CGST', gst_rate: 9, bill_reference: 'SL/2027-04' }),
      leg({ correct_account: 'Input SGST', dr_cr: 'Dr', amount: 4500, gst_head: 'SGST', gst_rate: 9, bill_reference: 'SL/2027-04' }),
      leg({ correct_account: 'TDS Payable — u/s 194J', dr_cr: 'Cr', amount: 5000, tds_section: '194J', tds_rate: 10, tds_base: 50000, bill_reference: 'SL/2027-04' }),
      leg({ correct_account: 'Sharma Legal', dr_cr: 'Cr', amount: 54000, bill_reference: 'SL/2027-04' }),
    ];
    const content = buildVendorInvoiceContent(service, 'On 10-Apr-2025, an invoice arrived from Sharma Legal (Ref SL/2027-04): post it from the attached invoice.');
    expect(content.invoiceNumber).toBe('SL/2027-04');
    expect(content.totalAmount).toBe(59000);
    expect(content.lineItems).toEqual([{ description: 'Legal & Professional Charges', quantity: 1, rate: 50000, amount: 50000, hsnSac: 'SAC 998211' }]);
    expect(content.taxBreakup).toEqual({ cgst_amount: 4500, sgst_amount: 4500, igst_amount: null });
    expect(content.vendorGSTIN.startsWith('29')).toBe(true);
    expect(content.buyerName).toBe(COMPANY_DETAILS.name);
  });

  it('prints a round-off leg as round off and flags reverse charge from RCM ledgers', () => {
    const rounded = [
      leg({ correct_account: 'Rent', dr_cr: 'Dr', amount: 10000, bill_reference: 'HR/77' }),
      leg({ correct_account: 'Input CGST', dr_cr: 'Dr', amount: 900.25, gst_head: 'CGST', gst_rate: 9, bill_reference: 'HR/77' }),
      leg({ correct_account: 'Input SGST', dr_cr: 'Dr', amount: 900.25, gst_head: 'SGST', gst_rate: 9, bill_reference: 'HR/77' }),
      leg({ correct_account: 'Hero Rentals', dr_cr: 'Cr', amount: 11800, bill_reference: 'HR/77' }),
      leg({ correct_account: 'Round Off', dr_cr: 'Cr', amount: 0.5, bill_reference: 'HR/77' }),
      leg({ correct_account: 'RCM Output CGST Payable', dr_cr: 'Cr', amount: 0, bill_reference: 'HR/77' }),
    ];
    const content = buildVendorInvoiceContent(rounded, 'On 03-Jun-2025, rent bill HR/77 from Hero Rentals.');
    expect(content.lineItems).toEqual([{ description: 'Rent', quantity: 1, rate: 10000, amount: 10000, hsnSac: 'SAC 997212' }]);
    expect(content.roundOff).toBe(-0.5);
    expect(content.reverseCharge).toBe(true);
  });

  it('numbers a cash purchase by code and refuses a credit purchase without a number or a line without a date', () => {
    const cash = [
      leg({ correct_account: 'Stationery', dr_cr: 'Dr', amount: 1000, bill_reference: null }),
      leg({ correct_account: 'Cash', dr_cr: 'Cr', amount: 1000, bill_reference: null }),
    ];
    expect(buildVendorInvoiceContent(cash, 'On 04-Jun-2025, stationery bought for cash.').invoiceNumber).toBe('CB-250604-07');
    const credit = goodsAndFreight.map((entry) => ({ ...entry, bill_reference: null }));
    expect(() => buildVendorInvoiceContent(credit, description)).toThrow(/no bill number of its own/);
    expect(() => buildVendorInvoiceContent(goodsAndFreight, 'An invoice arrived from Mumbai Suppliers.')).toThrow(/no date/);
  });

  it('refuses legs whose lines and tax do not add up to the party total', () => {
    const broken = goodsAndFreight.map((entry) => (entry.correct_account === 'Mumbai Suppliers' ? { ...entry, amount: 40000 } : entry));
    expect(() => buildVendorInvoiceContent(broken, description)).toThrow(/do not add up/);
  });
});

// The fallback engine's keys are looser than the builder's (pre-launch
// review, 2026-09-22): these shapes pass every generation check and used to
// print a wrong bill or throw after the retry loop.
describe('buildVendorInvoiceContent on the legacy engine key shapes', () => {
  const dt = (overrides: Partial<AnswerKeyEntry> & Pick<AnswerKeyEntry, 'correct_account' | 'dr_cr' | 'amount'>) => leg({ bill_reference: 'DT/503', ...overrides });
  const text = 'On 09-Jun-2025, an invoice arrived from Deccan Traders (Ref DT/503): post it from the attached invoice.';

  it('never takes a credited Round Off or Discount leg for the vendor, whatever the order', () => {
    const roundOffFirst = [
      dt({ correct_account: 'Purchases', dr_cr: 'Dr', amount: 10000.4 }),
      dt({ correct_account: 'Input CGST', dr_cr: 'Dr', amount: 900.04, gst_head: 'CGST', gst_rate: 9 }),
      dt({ correct_account: 'Input SGST', dr_cr: 'Dr', amount: 900.04, gst_head: 'SGST', gst_rate: 9 }),
      dt({ correct_account: 'Round Off', dr_cr: 'Cr', amount: 0.48 }),
      dt({ correct_account: 'Deccan Traders', dr_cr: 'Cr', amount: 11800 }),
    ];
    const content = buildVendorInvoiceContent(roundOffFirst, text);
    expect(content.vendorName).toBe('Deccan Traders');
    expect(content.totalAmount).toBe(11800);
    expect(content.roundOff).toBe(-0.48);
    expect(content.lineItems).toHaveLength(1);
  });

  it('adds a settlement discount the company books back to the bill total, like TDS', () => {
    const discounted = [
      dt({ correct_account: 'Discount Received', dr_cr: 'Cr', amount: 500 }),
      dt({ correct_account: 'Purchases', dr_cr: 'Dr', amount: 10000 }),
      dt({ correct_account: 'Input CGST', dr_cr: 'Dr', amount: 900, gst_head: 'CGST', gst_rate: 9 }),
      dt({ correct_account: 'Input SGST', dr_cr: 'Dr', amount: 900, gst_head: 'SGST', gst_rate: 9 }),
      dt({ correct_account: 'Deccan Traders', dr_cr: 'Cr', amount: 11300 }),
    ];
    const content = buildVendorInvoiceContent(discounted, text);
    expect(content.vendorName).toBe('Deccan Traders');
    expect(content.totalAmount).toBe(11800);
  });

  it("prints no GST for a bill whose voucher carries the company's own reverse-charge legs", () => {
    const rcmInside = [
      leg({ correct_account: 'Legal & Professional Charges', dr_cr: 'Dr', amount: 20000, bill_reference: 'SL/77' }),
      leg({ correct_account: 'Input CGST RCM', dr_cr: 'Dr', amount: 1800, gst_head: 'CGST', gst_rate: 9, bill_reference: 'SL/77' }),
      leg({ correct_account: 'Input SGST RCM', dr_cr: 'Dr', amount: 1800, gst_head: 'SGST', gst_rate: 9, bill_reference: 'SL/77' }),
      leg({ correct_account: 'Output CGST RCM', dr_cr: 'Cr', amount: 1800, gst_head: 'CGST', gst_rate: 9, bill_reference: 'SL/77' }),
      leg({ correct_account: 'Output SGST RCM', dr_cr: 'Cr', amount: 1800, gst_head: 'SGST', gst_rate: 9, bill_reference: 'SL/77' }),
      leg({ correct_account: 'Sharma Legal', dr_cr: 'Cr', amount: 20000, bill_reference: 'SL/77' }),
    ];
    const content = buildVendorInvoiceContent(rcmInside, 'On 09-Jun-2025, a legal bill SL/77 arrived from Sharma Legal.');
    expect(content.taxBreakup).toEqual({ cgst_amount: null, sgst_amount: null, igst_amount: null });
    expect(content.totalAmount).toBe(20000);
    expect(content.reverseCharge).toBe(true);
  });

  it('refuses a "round-off" of a rupee or more instead of letting it absorb legs that do not add up', () => {
    const absorbed = [
      dt({ correct_account: 'Purchases', dr_cr: 'Dr', amount: 10000 }),
      dt({ correct_account: 'Round Off', dr_cr: 'Dr', amount: 500 }),
      dt({ correct_account: 'Deccan Traders', dr_cr: 'Cr', amount: 10500 }),
    ];
    expect(() => buildVendorInvoiceContent(absorbed, text)).toThrow(/is not a round-off/);
  });
});
