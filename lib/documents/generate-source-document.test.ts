import { describe, expect, it } from 'vitest';
import {
  checkVendorInvoiceContent,
  missingBillNumbers,
  stampVendorInvoiceFromKey,
} from './generate-source-document';
import { isValidGstin, partyIdentityFor } from './party-directory';
import { COMPANY_DETAILS } from './company-details';
import { VendorInvoiceContentSchema } from '@/lib/schemas/source-document';
import type { GeneratedExercise } from '@/lib/schemas/exercise';
import {
  deriveInvoiceFigures,
  extractTransactionDate,
  type VendorInvoiceInput,
} from '@/lib/llm/prompts/source-document';
import type { AnswerKeyEntry } from '@/lib/schemas/exercise';
import type { VendorInvoiceContent } from '@/lib/schemas/source-document';

function leg(
  overrides: Partial<AnswerKeyEntry> & Pick<AnswerKeyEntry, 'correct_account' | 'dr_cr' | 'amount'>,
): AnswerKeyEntry {
  return {
    sequence: 3,
    voucher_type: 'Purchase',
    gst_head: null,
    gst_rate: null,
    tds_section: null,
    tds_rate: null,
    tds_base: null,
    bill_reference: 'DT-114',
    narration: null,
    concept_tags: ['purchase_voucher_basics'],
    requires_source_document: true,
    source_document_type: 'vendor_invoice',
    ...overrides,
  };
}

// Garima's live DT-114 transaction: the key expected 50,000 + 5,400 + 5,400
// = 60,800... rather, the PATCHED reality used here is the general shape:
// base + CGST + SGST legs Dr, party leg Cr carrying the total.
const MULTI_LEG: AnswerKeyEntry[] = [
  leg({ correct_account: 'Purchases', dr_cr: 'Dr', amount: 60000 }),
  leg({ correct_account: 'Input CGST', dr_cr: 'Dr', amount: 5400, gst_head: 'CGST', gst_rate: 18 }),
  leg({ correct_account: 'Input SGST', dr_cr: 'Dr', amount: 5400, gst_head: 'SGST', gst_rate: 18 }),
  leg({ correct_account: 'Deccan Traders', dr_cr: 'Cr', amount: 70800 }),
];

const INPUT: VendorInvoiceInput = {
  legs: MULTI_LEG,
  transactionDescription:
    'On 06-May-2026, a purchase invoice arrives from Deccan Traders (Karnataka), Bill DT-114: post it from the attached invoice.',
};

function content(overrides: Partial<VendorInvoiceContent>): VendorInvoiceContent {
  return {
    vendorName: 'Deccan Traders',
    vendorGSTIN: '29AAACD1234E1Z5',
    invoiceNumber: 'DT-114',
    invoiceDate: '06-May-2026',
    lineItems: [{ description: 'Trading goods', quantity: 1, rate: 60000, amount: 60000 }],
    taxBreakup: { cgst_amount: 5400, sgst_amount: 5400, igst_amount: null },
    totalAmount: 70800,
    ...overrides,
  };
}

describe('deriveInvoiceFigures', () => {
  it('reads base/tax/total off a multi-leg key', () => {
    expect(deriveInvoiceFigures(MULTI_LEG)).toMatchObject({
      vendorAccount: 'Deccan Traders',
      total: 70800,
      base: 60000,
      cgst: 5400,
      sgst: 5400,
      igst: null,
    });
  });

  it('splits a single-leg inclusive total by the stated rate', () => {
    const single = [leg({ correct_account: 'Mumbai Suppliers', dr_cr: 'Cr', amount: 94400, gst_head: 'IGST', gst_rate: 18 })];
    expect(deriveInvoiceFigures(single)).toMatchObject({
      vendorAccount: 'Mumbai Suppliers',
      total: 94400,
      base: 80000,
      cgst: null,
      sgst: null,
      igst: 14400,
    });
  });

  it('treats CGST/SGST gst_rate as PER-HEAD when splitting a single-leg total', () => {
    // Praveen's live DT/334 key: 69,620 inclusive at CGST gst_rate 9 (i.e.
    // 9% + 9% = 18% combined) must split to 59,000 + 5,310 + 5,310 — the
    // as-combined reading produced 63,872 + 2,874 + 2,874 (caught by the
    // 2026-09-01 live cross-check).
    const single = [leg({ correct_account: 'Deccan Traders', dr_cr: 'Cr', amount: 69620, gst_head: 'CGST', gst_rate: 9 })];
    expect(deriveInvoiceFigures(single)).toMatchObject({
      vendorAccount: 'Deccan Traders',
      total: 69620,
      base: 59000,
      cgst: 5310,
      sgst: 5310,
      igst: null,
    });
  });

  it('handles a no-GST single leg', () => {
    const single = [leg({ correct_account: 'Mumbai Suppliers', dr_cr: 'Cr', amount: 30000 })];
    expect(deriveInvoiceFigures(single)).toMatchObject({
      vendorAccount: 'Mumbai Suppliers',
      total: 30000,
      base: 30000,
      cgst: null,
      sgst: null,
      igst: null,
    });
  });
});

describe('checkVendorInvoiceContent (the live document-vs-key contradictions)', () => {
  it('accepts an invoice matching the key figure-for-figure', () => {
    expect(checkVendorInvoiceContent(content({}), INPUT)).toBeNull();
  });

  it('requires the printed invoice number to be the bill reference the key scores (2026-09-11)', () => {
    const withReference: VendorInvoiceInput = {
      ...INPUT,
      legs: MULTI_LEG.map((entry) => (entry.correct_account === 'Deccan Traders' ? { ...entry, bill_reference: 'DT-114' } : entry)),
    };
    expect(checkVendorInvoiceContent(content({}), withReference)).toBeNull();
    const error = checkVendorInvoiceContent(content({ invoiceNumber: 'DT/0114' }), withReference);
    expect(error).toContain('invoiceNumber is "DT/0114" but must be exactly "DT-114"');
  });

  it('rejects the live failure: total printed as the base with understated tax', () => {
    // Garima's delivered DT-114 PDF: 50,000 + 5,000 + 5,000 = 60,000 against
    // a key expecting 70,800.
    const bad = content({
      lineItems: [{ description: 'Trading goods', quantity: 1, rate: 50000, amount: 50000 }],
      taxBreakup: { cgst_amount: 5000, sgst_amount: 5000, igst_amount: null },
      totalAmount: 60000,
    });
    const error = checkVendorInvoiceContent(bad, INPUT);
    expect(error).toContain('must sum to exactly 60000');
    expect(error).toContain('must be exactly 70800');
  });

  it('rejects the live failure: invented "2024-01-15" invoice date', () => {
    const error = checkVendorInvoiceContent(content({ invoiceDate: '2024-01-15' }), INPUT);
    expect(error).toContain('invoiceDate');
    expect(error).toContain('06-May-2026');
  });

  it('accepts the same date in ISO form', () => {
    expect(checkVendorInvoiceContent(content({ invoiceDate: '2026-05-06' }), INPUT)).toBeNull();
  });

  it('rejects a dropped tax head (the live IGST 0.00 failure)', () => {
    const singleInput: VendorInvoiceInput = {
      legs: [leg({ correct_account: 'Mumbai Suppliers', dr_cr: 'Cr', amount: 59000, gst_head: 'IGST', gst_rate: 18 })],
      transactionDescription: 'On 09-May-2026, a purchase invoice arrives from Mumbai Suppliers, Bill MS-331: post it from the attached invoice.',
    };
    const bad = content({
      vendorName: 'Mumbai Suppliers',
      invoiceNumber: 'MS-331',
      invoiceDate: '09-May-2026',
      lineItems: [{ description: 'Trading goods', quantity: 1, rate: 50000, amount: 50000 }],
      taxBreakup: { cgst_amount: null, sgst_amount: null, igst_amount: 0 },
      totalAmount: 50000,
    });
    const error = checkVendorInvoiceContent(bad, singleInput);
    expect(error).toContain('igst_amount');
  });

  it('rejects an invented vendor name', () => {
    const error = checkVendorInvoiceContent(content({ vendorName: 'Shree Traders' }), INPUT);
    expect(error).toContain('vendorName');
  });

  it('tolerates a null-vs-zero unused tax head', () => {
    expect(
      checkVendorInvoiceContent(
        content({ taxBreakup: { cgst_amount: 5400, sgst_amount: 5400, igst_amount: 0 } }),
        INPUT,
      ),
    ).toBeNull();
  });
});

describe('extractTransactionDate', () => {
  it('parses the standard batch phrasing', () => {
    expect(extractTransactionDate('On 06-May-2026, a purchase invoice arrives.')).toEqual({
      day: 6,
      monthIndex: 4,
      year: 2026,
    });
  });

  it('parses numeric DD-MM-YYYY', () => {
    expect(extractTransactionDate('On 06-05-2026, goods arrived.')).toEqual({
      day: 6,
      monthIndex: 4,
      year: 2026,
    });
  });

  it('returns null when no date is present', () => {
    expect(extractTransactionDate('Early in the month, goods arrived.')).toBeNull();
  });
});

describe('deriveInvoiceFigures on a TDS purchase (Praveen Level 6 legal fee, 2026-09-03)', () => {
  it('names the vendor, not TDS Payable, and prints the gross fee as the total', () => {
    const figures = deriveInvoiceFigures([
      leg({ correct_account: 'Legal & Professional Charges', dr_cr: 'Dr', amount: 20000, tds_section: '194J', tds_rate: 10, tds_base: 20000 }),
      leg({ correct_account: 'TDS Payable — u/s 194J', dr_cr: 'Cr', amount: 2000, tds_section: '194J', tds_rate: 10, tds_base: 20000 }),
      leg({ correct_account: 'Sharma Legal', dr_cr: 'Cr', amount: 18000, tds_section: '194J', tds_rate: 10, tds_base: 20000 }),
    ]);
    expect(figures.vendorAccount).toBe('Sharma Legal');
    expect(figures.total).toBe(20000);
    expect(figures.base).toBe(20000);
    expect(figures.igst).toBeNull();
  });
});


import { alignLineItemsToLegs } from './generate-source-document';

describe('multi-leg invoices print one line per expense leg (Garima Level 5 MS-3102, 2026-09-04)', () => {
  const leg = (account: string, drCr: 'Dr' | 'Cr', amount: number, gstHead: 'IGST' | null = null): AnswerKeyEntry => ({
    sequence: 6, correct_account: account, dr_cr: drCr, amount, voucher_type: 'Purchase',
    gst_head: gstHead, gst_rate: gstHead ? 18 : null, tds_section: null, tds_rate: null, tds_base: null,
    bill_reference: 'MS-3102 (New Ref)', narration: null, concept_tags: ['purchase_voucher_basics'],
    requires_source_document: true, source_document_type: 'vendor_invoice',
  });
  const legs = [leg('Purchases', 'Dr', 35000), leg('Freight & Delivery Charges', 'Dr', 2000), leg('Input IGST', 'Dr', 6660, 'IGST'), leg('Mumbai Suppliers', 'Cr', 43660)];
  const input: VendorInvoiceInput = { legs, transactionDescription: 'On 10-Aug-2026, a purchase invoice arrives from Mumbai Suppliers covering goods and freight together on one bill: post it from the attached invoice.' };
  const liveContent: VendorInvoiceContent = {
    vendorName: 'Mumbai Suppliers', vendorGSTIN: '27AABCT5055K1Z4', invoiceNumber: 'MS-3102', invoiceDate: '10-Aug-2026',
    lineItems: [
      { description: 'Cotton fabric roll, 50 meters', quantity: 2, rate: 8500, amount: 17000 },
      { description: 'Freight and handling charges', quantity: 1, rate: 20000, amount: 20000 },
    ],
    taxBreakup: { cgst_amount: null, sgst_amount: null, igst_amount: 6660 }, totalAmount: 43660,
  };

  it('exposes the per-leg base lines', () => {
    expect(deriveInvoiceFigures(legs).baseLines).toEqual([{ account: 'Purchases', amount: 35000 }, { account: 'Freight & Delivery Charges', amount: 2000 }]);
  });

  it('rejects the live split: right total, wrong goods/freight amounts', () => {
    expect(checkVendorInvoiceContent(liveContent, input)).toMatch(/one per component: Purchases 35000, Freight & Delivery Charges 2000/);
  });

  it('realigns the lines to the legs, keeping the freight wording on the freight leg', () => {
    const aligned = alignLineItemsToLegs(liveContent, deriveInvoiceFigures(legs));
    expect(aligned.lineItems).toEqual([
      { description: 'Cotton fabric roll, 50 meters', quantity: 1, rate: 35000, amount: 35000 },
      { description: 'Freight and handling charges', quantity: 1, rate: 2000, amount: 2000 },
    ]);
    expect(checkVendorInvoiceContent(aligned, input)).toBeNull();
  });

  it('leaves a single-expense-leg invoice free to split its lines', () => {
    const single = [leg('Purchases', 'Dr', 37000), leg('Input IGST', 'Dr', 6660, 'IGST'), leg('Mumbai Suppliers', 'Cr', 43660)];
    const content = { ...liveContent, lineItems: [{ description: 'A', quantity: 1, rate: 17000, amount: 17000 }, { description: 'B', quantity: 1, rate: 20000, amount: 20000 }] };
    expect(alignLineItemsToLegs(content, deriveInvoiceFigures(single))).toBe(content);
    expect(checkVendorInvoiceContent(content, { ...input, legs: single })).toBeNull();
  });
});


describe('a single expense leg prints a single line (Praveen MA/206, 2026-09-04)', () => {
  const leg = (account: string, drCr: 'Dr' | 'Cr', amount: number, gstHead: 'CGST' | 'SGST' | null = null): AnswerKeyEntry => ({
    sequence: 2, correct_account: account, dr_cr: drCr, amount, voucher_type: 'Purchase',
    gst_head: gstHead, gst_rate: gstHead ? 9 : null, tds_section: null, tds_rate: null, tds_base: null,
    bill_reference: 'MA/206', narration: null, concept_tags: ['purchase_voucher_basics'],
    requires_source_document: true, source_document_type: 'vendor_invoice',
  });
  const serviceLegs = [leg('Legal & Professional Charges', 'Dr', 15000), leg('Input CGST', 'Dr', 1350, 'CGST'), leg('Input SGST', 'Dr', 1350, 'SGST'), leg('Mehta & Associates', 'Cr', 17700)];
  const input: VendorInvoiceInput = { legs: serviceLegs, transactionDescription: 'On 04-Oct-2026, an invoice arrives from Mehta & Associates for professional services rendered this month.' };
  const twoLines: VendorInvoiceContent = {
    vendorName: 'Mehta & Associates', vendorGSTIN: '29AABCM1234F1ZT', invoiceNumber: 'MA/206', invoiceDate: '04-Oct-2026',
    lineItems: [
      { description: 'Professional consultation services', quantity: 1, rate: 10000, amount: 10000 },
      { description: 'Audit and compliance review', quantity: 1, rate: 5000, amount: 5000 },
    ],
    taxBreakup: { cgst_amount: 1350, sgst_amount: 1350, igst_amount: null }, totalAmount: 17700,
  };

  it('rejects a split service bill', () => {
    expect(checkVendorInvoiceContent(twoLines, input)).toMatch(/exactly one line for "Legal & Professional Charges"/);
  });

  it('collapses the split into one line carrying the leg amount', () => {
    const aligned = alignLineItemsToLegs(twoLines, deriveInvoiceFigures(serviceLegs));
    expect(aligned.lineItems).toEqual([{ description: 'Professional consultation services', quantity: 1, rate: 15000, amount: 15000 }]);
    expect(checkVendorInvoiceContent(aligned, input)).toBeNull();
  });

  it('still lets a goods purchase print several stock lines', () => {
    const goods = [leg('Purchases', 'Dr', 15000), leg('Input CGST', 'Dr', 1350, 'CGST'), leg('Input SGST', 'Dr', 1350, 'SGST'), leg('Mehta & Associates', 'Cr', 17700)];
    expect(alignLineItemsToLegs(twoLines, deriveInvoiceFigures(goods))).toBe(twoLines);
    expect(checkVendorInvoiceContent(twoLines, { ...input, legs: goods })).toBeNull();
  });
});


// Everything the vendor invoice prints comes from the key (2026-09-17).
describe('stampVendorInvoiceFromKey (the PDF can never disagree with the key)', () => {
  const legs: AnswerKeyEntry[] = [
    leg({ correct_account: 'Purchases', dr_cr: 'Dr', amount: 35000, bill_reference: 'MS/990 (New Ref)' }),
    leg({ correct_account: 'Freight & Delivery Charges', dr_cr: 'Dr', amount: 2000, bill_reference: 'MS/990 (New Ref)' }),
    leg({ correct_account: 'Input IGST', dr_cr: 'Dr', amount: 6660, gst_head: 'IGST', gst_rate: 18, bill_reference: 'MS/990 (New Ref)' }),
    leg({ correct_account: 'Mumbai Suppliers', dr_cr: 'Cr', amount: 43660, bill_reference: 'MS/990 (New Ref)' }),
  ];
  const input: VendorInvoiceInput = {
    legs,
    transactionDescription: 'On 15-Jun-2025, an invoice arrived from Mumbai Suppliers (Ref MS/990): post it from the attached invoice.',
  };
  // What the model returned: passes the checks (tolerant name/number/date
  // forms) but prints a variant name, number casing, ISO date, an invented
  // GSTIN and quantities that do not multiply out.
  const modelContent: VendorInvoiceContent = {
    vendorName: 'Mumbai Suppliers Pvt Ltd',
    vendorGSTIN: 'GSTIN-THE-MODEL-INVENTED',
    invoiceNumber: ' ms/990 ',
    invoiceDate: '2025-06-15',
    lineItems: [
      { description: 'Freight and handling', quantity: 3, rate: 500, amount: 2000 },
      { description: 'Cotton fabric rolls', quantity: 7, rate: 5000, amount: 35000 },
    ],
    taxBreakup: { cgst_amount: 0, sgst_amount: null, igst_amount: 6660.004 },
    totalAmount: 43660,
  };

  it('passes the checks first, then overwrites every printed fact from the key', () => {
    expect(checkVendorInvoiceContent(modelContent, input)).toBeNull();
    const stamped = stampVendorInvoiceFromKey(modelContent, input);
    const vendor = partyIdentityFor('Mumbai Suppliers');
    expect(stamped).toEqual({
      vendorName: 'Mumbai Suppliers',
      vendorGSTIN: vendor.gstin,
      vendorAddress: vendor.address,
      invoiceNumber: 'MS/990',
      invoiceDate: '15-Jun-2025',
      lineItems: [
        { description: 'Cotton fabric rolls', quantity: 1, rate: 35000, amount: 35000, hsnSac: 'HSN 6304' },
        { description: 'Freight and handling', quantity: 1, rate: 2000, amount: 2000, hsnSac: 'SAC 996511' },
      ],
      taxBreakup: { cgst_amount: null, sgst_amount: null, igst_amount: 6660 },
      totalAmount: 43660,
      buyerName: COMPANY_DETAILS.name,
      buyerGSTIN: COMPANY_DETAILS.gstin,
      buyerAddress: COMPANY_DETAILS.address,
      placeOfSupply: 'Karnataka',
      placeOfSupplyCode: '29',
      reverseCharge: false,
      taxRatePercent: 18,
      amountInWords: 'Rupees Forty Three Thousand Six Hundred Sixty Only',
    });
    expect(isValidGstin(stamped.vendorGSTIN)).toBe(true);
    expect(VendorInvoiceContentSchema.parse(stamped)).toEqual(stamped);
  });

  it('makes quantity x rate equal the amount on free-form goods lines', () => {
    const goods = [
      leg({ correct_account: 'Purchases', dr_cr: 'Dr', amount: 37000, bill_reference: 'MS/991' }),
      leg({ correct_account: 'Input IGST', dr_cr: 'Dr', amount: 6660, gst_head: 'IGST', gst_rate: 18, bill_reference: 'MS/991' }),
      leg({ correct_account: 'Mumbai Suppliers', dr_cr: 'Cr', amount: 43660, bill_reference: 'MS/991' }),
    ];
    const content: VendorInvoiceContent = {
      ...modelContent,
      invoiceNumber: 'MS/991',
      lineItems: [
        { description: 'Cotton', quantity: 4, rate: 5000, amount: 20000 },
        { description: 'Polyester', quantity: 3, rate: 5000, amount: 17000 },
      ],
    };
    const stamped = stampVendorInvoiceFromKey(content, { ...input, legs: goods });
    expect(stamped.lineItems).toEqual([
      { description: 'Cotton', quantity: 4, rate: 5000, amount: 20000, hsnSac: 'HSN 6304' },
      { description: 'Polyester', quantity: 1, rate: 17000, amount: 17000, hsnSac: 'HSN 6304' },
    ]);
  });

  it('prints a round-off leg as round off, and flags reverse charge from RCM ledgers', () => {
    const rounded = [
      leg({ correct_account: 'Rent', dr_cr: 'Dr', amount: 10000, bill_reference: 'HR/77' }),
      leg({ correct_account: 'Input CGST', dr_cr: 'Dr', amount: 900.25, gst_head: 'CGST', gst_rate: 9, bill_reference: 'HR/77' }),
      leg({ correct_account: 'Input SGST', dr_cr: 'Dr', amount: 900.25, gst_head: 'SGST', gst_rate: 9, bill_reference: 'HR/77' }),
      leg({ correct_account: 'Hero Rentals', dr_cr: 'Cr', amount: 11800, bill_reference: 'HR/77' }),
      leg({ correct_account: 'Round Off', dr_cr: 'Cr', amount: 0.5, bill_reference: 'HR/77' }),
      leg({ correct_account: 'RCM Output CGST Payable', dr_cr: 'Cr', amount: 0, bill_reference: 'HR/77' }),
    ];
    const content: VendorInvoiceContent = {
      ...modelContent,
      vendorName: 'Hero Rentals',
      invoiceNumber: 'HR/77',
      lineItems: [{ description: 'Office rent', quantity: 1, rate: 10000, amount: 10000 }],
      taxBreakup: { cgst_amount: 900.25, sgst_amount: 900.25, igst_amount: null },
      totalAmount: 11800,
    };
    const stamped = stampVendorInvoiceFromKey(content, { ...input, legs: rounded });
    expect(stamped.lineItems).toEqual([{ description: 'Office rent', quantity: 1, rate: 10000, amount: 10000, hsnSac: 'SAC 997212' }]);
    expect(stamped.roundOff).toBe(-0.5);
    expect(stamped.reverseCharge).toBe(true);
  });
});

describe('invoice number comparison is honest (2026-09-17)', () => {
  const withNumber = (number: string): VendorInvoiceInput => ({
    ...INPUT,
    legs: MULTI_LEG.map((entry) => ({ ...entry, bill_reference: number })),
  });

  it('no longer accepts INV-10-1 for INV-1-01 by stripping punctuation', () => {
    expect(checkVendorInvoiceContent(content({ invoiceNumber: 'INV-10-1' }), withNumber('INV-1-01'))).toContain('must be exactly "INV-1-01"');
  });

  it('still tolerates case and surrounding whitespace', () => {
    expect(checkVendorInvoiceContent(content({ invoiceNumber: ' inv-1-01 ' }), withNumber('INV-1-01'))).toBeNull();
  });
});

describe('missingBillNumbers (a credit voucher must carry its own number)', () => {
  const entry = (sequence: number, voucherType: string, account: string, drCr: 'Dr' | 'Cr', amount: number, ref: string | null) =>
    leg({ sequence, voucher_type: voucherType, correct_account: account, dr_cr: drCr, amount, bill_reference: ref });

  it('reports credit purchases and credit sales with no own number, never cash vouchers or other voucher types', () => {
    const generated = {
      transactions: [],
      answer_key: {
        entries: [
          entry(1, 'Purchase', 'Purchases', 'Dr', 1000, null),
          entry(1, 'Purchase', 'Deccan Traders', 'Cr', 1000, null),
          entry(2, 'Sales', 'Karnataka Emporium', 'Dr', 2000, 'ADV-C01 (Advance)'),
          entry(2, 'Sales', 'Sales', 'Cr', 2000, 'ADV-C01 (Advance)'),
          entry(3, 'Sales', 'Cash', 'Dr', 500, null),
          entry(3, 'Sales', 'Sales', 'Cr', 500, null),
          entry(4, 'Purchase', 'Purchases', 'Dr', 800, null),
          entry(4, 'Purchase', 'Cash', 'Cr', 800, null),
          entry(5, 'Sales', 'Karnataka Emporium', 'Dr', 3000, 'ADV-C01 (Advance), INV-3001'),
          entry(5, 'Sales', 'Sales', 'Cr', 3000, 'ADV-C01 (Advance), INV-3001'),
          entry(6, 'Payment', 'Deccan Traders', 'Dr', 1000, null),
          entry(6, 'Payment', 'HDFC Bank', 'Cr', 1000, null),
        ],
      },
    } as unknown as GeneratedExercise;
    expect(missingBillNumbers(generated)).toEqual([
      { sequence: 1, voucherType: 'Purchase', party: 'Deccan Traders' },
      { sequence: 2, voucherType: 'Sales', party: 'Karnataka Emporium' },
    ]);
  });
});
