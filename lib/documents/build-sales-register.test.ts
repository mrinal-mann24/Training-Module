import { describe, expect, it } from 'vitest';
import type { SalesInvoiceContent } from '@/lib/schemas/source-document';
import { GeneratedSourceDocumentSchema } from '@/lib/schemas/source-document';
import { SALES_REGISTER_COLUMNS, buildSalesRegisterContent, formatRegisterDate, renderSalesRegisterCsv } from './build-sales-register';
import { renderSourceDocument } from './render-source-document';

function invoice(overrides: Partial<SalesInvoiceContent> = {}): SalesInvoiceContent {
  return {
    sellerName: 'Blossom Retail Pvt Ltd',
    sellerGSTIN: '29AABCB1234H1Z5',
    sellerAddress: '12 MG Road, Bengaluru',
    buyerName: 'Karnataka Emporium',
    buyerGSTIN: '29AABCK1234E1Z5',
    placeOfSupply: 'Karnataka',
    invoiceNumber: 'INV-070',
    invoiceDate: '02-Apr-2025',
    isCashMemo: false,
    lineItems: [{ description: 'Trading goods as per order', quantity: 1, rate: 40000, amount: 40000 }],
    taxBreakup: { cgst_amount: 3600, sgst_amount: 3600, igst_amount: null },
    totalAmount: 47200,
    ...overrides,
  };
}

describe('buildSalesRegisterContent', () => {
  it('lists one row per invoice with the invoice figures, and none when there is no sale', () => {
    const content = buildSalesRegisterContent(
      [
        invoice(),
        invoice({
          buyerName: 'Chennai Home Store',
          buyerGSTIN: null,
          placeOfSupply: 'Tamil Nadu',
          invoiceNumber: 'INV-071',
          invoiceDate: '10-Apr-2025',
          lineItems: [{ description: 'Trading goods as per order', quantity: 1, rate: 90000, amount: 90000 }],
          taxBreakup: { cgst_amount: null, sgst_amount: null, igst_amount: 16200 },
          totalAmount: 106200,
        }),
        invoice({ buyerName: 'Cash (walk-in customer)', invoiceNumber: 'CM-250405-03', invoiceDate: '05-Apr-2025', isCashMemo: true, lineItems: [{ description: 'Counter sale', quantity: 1, rate: 2000, amount: 2000 }], taxBreakup: { cgst_amount: 180, sgst_amount: 180, igst_amount: null }, totalAmount: 2360 }),
      ],
      { period: 'April 2025' },
    );
    expect(content).not.toBeNull();
    expect(content?.period).toBe('April 2025');
    expect(content?.sellerGSTIN).toBe('29AABCB1234H1Z5');
    expect(content?.rows).toEqual([
      { invoiceNumber: 'INV-070', invoiceDate: '02-Apr-2025', customerName: 'Karnataka Emporium', customerGSTIN: '29AABCK1234E1Z5', placeOfSupply: 'Karnataka', isCashMemo: false, taxableValue: 40000, cgst: 3600, sgst: 3600, igst: 0, total: 47200 },
      { invoiceNumber: 'INV-071', invoiceDate: '10-Apr-2025', customerName: 'Chennai Home Store', customerGSTIN: null, placeOfSupply: 'Tamil Nadu', isCashMemo: false, taxableValue: 90000, cgst: 0, sgst: 0, igst: 16200, total: 106200 },
      { invoiceNumber: 'CM-250405-03', invoiceDate: '05-Apr-2025', customerName: 'Cash (walk-in customer)', customerGSTIN: null, placeOfSupply: 'Karnataka', isCashMemo: true, taxableValue: 2000, cgst: 180, sgst: 180, igst: 0, total: 2360 },
    ]);
    // Every row's parts add to its total, the same identity the invoice keeps.
    for (const row of content?.rows ?? []) expect(row.taxableValue + row.cgst + row.sgst + row.igst).toBe(row.total);
    expect(buildSalesRegisterContent([], { period: 'April 2025' })).toBeNull();
    expect(GeneratedSourceDocumentSchema.parse({ doc_type: 'sales_register', content }).doc_type).toBe('sales_register');
  });
});

describe('renderSalesRegisterCsv', () => {
  it('writes a BOM-prefixed, CRLF, fully quoted CSV with the column header and DD-MM-YYYY dates', () => {
    const content = buildSalesRegisterContent([invoice({ buyerName: 'Mehta & Associates, Bengaluru' })], { period: 'April 2025' });
    const csv = renderSalesRegisterCsv(content!).toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines).toEqual([
      SALES_REGISTER_COLUMNS.map((c) => `"${c}"`).join(','),
      '"INV-070","02-04-2025","Mehta & Associates, Bengaluru","29AABCK1234E1Z5","Karnataka","Tax Invoice","40000.00","3600.00","3600.00","0.00","47200.00"',
      '',
    ]);
  });

  it('converts invoice dates and passes anything else through', () => {
    expect(formatRegisterDate('2-Apr-2025')).toBe('02-04-2025');
    expect(formatRegisterDate('31-Mar-2025')).toBe('31-03-2025');
    expect(formatRegisterDate('2025-04-02')).toBe('2025-04-02');
  });

  it('is the one non-PDF document in the format-aware renderer', async () => {
    const content = buildSalesRegisterContent([invoice()], { period: 'April 2025' })!;
    const rendered = await renderSourceDocument({ doc_type: 'sales_register', content }, 'seed');
    expect(rendered.extension).toBe('csv');
    expect(rendered.contentType).toBe('text/csv');
    expect(rendered.bytes.toString('utf8')).toContain('"INV-070"');
  });
});
