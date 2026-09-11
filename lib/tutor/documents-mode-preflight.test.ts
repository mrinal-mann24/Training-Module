import { describe, expect, it } from 'vitest';
import type { ConceptTag, GeneratedExercise } from '@/lib/schemas/exercise';
import { checkSalesInvoicesBuildable } from './documents-mode';

// 2026-09-11: the sales-invoice builder used to run only after every
// validation had passed and threw on a sale it could not print, so the
// generation job died instead of asking the model for another attempt.

type Entry = GeneratedExercise['answer_key']['entries'][number];

function leg(sequence: number, account: string, drCr: 'Dr' | 'Cr', amount: number, extra: Partial<Entry> = {}): Entry {
  return {
    sequence,
    correct_account: account,
    dr_cr: drCr,
    amount,
    voucher_type: 'Sales',
    gst_head: null,
    gst_rate: null,
    tds_section: null,
    tds_rate: null,
    tds_base: null,
    bill_reference: null,
    narration: null,
    concept_tags: ['sales_voucher_basics'] as ConceptTag[],
    requires_source_document: false,
    source_document_type: null,
    ...extra,
  };
}

function exercise(description: string, entries: Entry[]): GeneratedExercise {
  return {
    scenario: 'Batch.',
    difficulty_level: 'L3',
    variant: 'A',
    transactions: [{ sequence: 1, description }],
    answer_key: { entries },
  };
}

const COMPANY = 'Blossom Retail Pvt Ltd';

describe('checkSalesInvoicesBuildable', () => {
  const sale = [
    leg(1, 'Karnataka Emporium', 'Dr', 70800, { bill_reference: 'INV-090' }),
    leg(1, 'Sales', 'Cr', 60000),
    leg(1, 'Output CGST', 'Cr', 5400, { gst_head: 'CGST', gst_rate: 9 }),
    leg(1, 'Output SGST', 'Cr', 5400, { gst_head: 'SGST', gst_rate: 9 }),
  ];

  it('accepts a dated sale whose lines add up', () => {
    expect(checkSalesInvoicesBuildable(exercise('On 03-May-2025, you raised Sales Invoice INV-090 on Karnataka Emporium.', sale), COMPANY)).toBeNull();
  });

  it('reports a sale with no date instead of throwing', () => {
    const error = checkSalesInvoicesBuildable(exercise('You raised Sales Invoice INV-090 on Karnataka Emporium.', sale), COMPANY);
    expect(error).toContain('no date');
    expect(error).toContain('Give every sale a date');
  });

  it('reports a sale whose lines do not add up to the customer total', () => {
    const short = sale.map((entry) => (entry.correct_account === 'Sales' ? { ...entry, amount: 59000 } : entry));
    const error = checkSalesInvoicesBuildable(exercise('On 03-May-2025, you raised Sales Invoice INV-090 on Karnataka Emporium.', short), COMPANY);
    expect(error).toContain('do not add up');
  });

  it('ignores vouchers that are not sales', () => {
    const purchase = [
      leg(1, 'Purchases', 'Dr', 10000, { voucher_type: 'Purchase' }),
      leg(1, 'Mumbai Suppliers', 'Cr', 10000, { voucher_type: 'Purchase', bill_reference: 'MS-700' }),
    ];
    expect(checkSalesInvoicesBuildable(exercise('An invoice arrived from Mumbai Suppliers.', purchase), COMPANY)).toBeNull();
  });
});
