import { describe, expect, it } from 'vitest';
import {
  missingBillNumbers,
} from './generate-source-document';
import type { GeneratedExercise } from '@/lib/schemas/exercise';
import {
  deriveInvoiceFigures,
  extractTransactionDate,
} from '@/lib/documents/invoice-figures';
import type { AnswerKeyEntry } from '@/lib/schemas/exercise';

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
