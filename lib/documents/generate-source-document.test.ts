import { describe, expect, it } from 'vitest';
import { checkVendorInvoiceContent } from './generate-source-document';
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
    expect(deriveInvoiceFigures(MULTI_LEG)).toEqual({
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
    expect(deriveInvoiceFigures(single)).toEqual({
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
    expect(deriveInvoiceFigures(single)).toEqual({
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
    expect(deriveInvoiceFigures(single)).toEqual({
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
