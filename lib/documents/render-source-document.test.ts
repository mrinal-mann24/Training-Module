import { describe, expect, it } from 'vitest';
import type { SalesInvoiceContent, VendorInvoiceContent } from '@/lib/schemas/source-document';
import { renderSourceDocumentPdf } from './render-source-document';
import { pickFormatIndex, VENDOR_INVOICE_FORMAT_COUNT } from './pick-template';

// Rule 46 fields are optional (2026-09-17): documents stored before them
// must still render in every layout, and the stamped ones too.
const OLD_VENDOR: VendorInvoiceContent = {
  vendorName: 'Deccan Traders',
  vendorGSTIN: '29AUMCD4595H1ZW',
  invoiceNumber: 'DT-114',
  invoiceDate: '06-May-2026',
  lineItems: [{ description: 'Trading goods', quantity: 1, rate: 60000, amount: 60000 }],
  taxBreakup: { cgst_amount: 5400, sgst_amount: 5400, igst_amount: null },
  totalAmount: 70800,
};

const NEW_VENDOR: VendorInvoiceContent = {
  ...OLD_VENDOR,
  vendorAddress: '#60, Main Bazaar, Bengaluru 560099, Karnataka',
  lineItems: [{ description: 'Trading goods', quantity: 1, rate: 60000, amount: 60000, hsnSac: 'HSN 6304' }],
  buyerName: 'Blossom Retail Pvt Ltd',
  buyerGSTIN: '29AABCB1234H1Z5',
  buyerAddress: '#123, 5th Cross, Indiranagar, Bengaluru 560038, Karnataka',
  placeOfSupply: 'Karnataka',
  placeOfSupplyCode: '29',
  reverseCharge: false,
  taxRatePercent: 18,
  roundOff: 0,
  amountInWords: 'Rupees Seventy Thousand Eight Hundred Only',
};

// One seed per vendor layout, found through the real picker.
function seedsForEveryLayout(): string[] {
  const seeds = new Map<number, string>();
  for (let index = 0; seeds.size < VENDOR_INVOICE_FORMAT_COUNT && index < 500; index += 1) {
    const seed = `render-test:${index}`;
    const format = pickFormatIndex('vendor_invoice', seed);
    if (!seeds.has(format)) seeds.set(format, seed);
  }
  return [...seeds.values()];
}

describe('invoice PDFs render with and without the Rule 46 particulars', () => {
  it('renders every vendor layout for a stored (old) and a stamped (new) invoice', async () => {
    const seeds = seedsForEveryLayout();
    expect(seeds).toHaveLength(VENDOR_INVOICE_FORMAT_COUNT);
    for (const seed of seeds) {
      for (const content of [OLD_VENDOR, NEW_VENDOR]) {
        const pdf = await renderSourceDocumentPdf({ doc_type: 'vendor_invoice', content }, seed);
        expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
      }
    }
  }, 60000);

  it('renders a sales invoice with and without the particulars', async () => {
    const sale: SalesInvoiceContent = {
      sellerName: 'Blossom Retail Pvt Ltd',
      sellerGSTIN: '29AABCB1234H1Z5',
      sellerAddress: '#123, 5th Cross, Indiranagar, Bengaluru 560038, Karnataka',
      buyerName: 'Karnataka Emporium',
      placeOfSupply: 'Karnataka',
      invoiceNumber: 'INV-062',
      invoiceDate: '03-Mar-2025',
      isCashMemo: false,
      lineItems: [{ description: 'Trading goods as per order', quantity: 1, rate: 60000, amount: 60000 }],
      taxBreakup: { cgst_amount: 5400, sgst_amount: 5400, igst_amount: null },
      totalAmount: 70800,
    };
    const stamped: SalesInvoiceContent = {
      ...sale,
      lineItems: [{ ...sale.lineItems[0], hsnSac: 'HSN 6304' }],
      placeOfSupplyCode: '29',
      reverseCharge: false,
      taxRatePercent: 18,
      amountInWords: 'Rupees Seventy Thousand Eight Hundred Only',
    };
    for (const content of [sale, stamped]) {
      const pdf = await renderSourceDocumentPdf({ doc_type: 'sales_invoice', content }, 'sale');
      expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    }
  }, 60000);
});
