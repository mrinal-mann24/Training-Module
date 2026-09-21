import { describe, expect, it } from 'vitest';
import type { AnswerKey, ConceptTag, GeneratedExercise } from '@/lib/schemas/exercise';
import {
  documentNumberOf,
  normalizeBillReference,
  openBillsFromKeys,
  parseBillReferences,
  splitBillReferences,
} from '@/lib/db/queries/company';
import { applyDocumentsMode, buildSalesInvoiceContent } from './documents-mode';
import { checkBillNumberUniqueness, priorBillReferences } from './generation-checks';
import { checkVendorInvoiceContent } from '@/lib/documents/generate-source-document';
import { buildVendorInvoicePrompt } from '@/lib/llm/prompts/source-document';

// Regression (2026-09-15): Praveen's June 2025 batch printed the ADVANCE
// reference as the document number: sales invoices "ADV-C01" / "ADV-C02"
// instead of INV-3001 / INV-3002, and the Mumbai Suppliers bill "ADV-S01"
// instead of MS/990. The answer key names the advance being adjusted AND
// the new document on the same voucher ("ADV-C01 (Advance), INV-3001"),
// and every consumer took the first reference. The fixture below mirrors
// that key, trimmed to the advance transactions.

type Entry = GeneratedExercise['answer_key']['entries'][number];

function leg(sequence: number, voucherType: string, account: string, drCr: 'Dr' | 'Cr', amount: number, extra: Partial<Entry> = {}): Entry {
  return {
    sequence,
    correct_account: account,
    dr_cr: drCr,
    amount,
    voucher_type: voucherType,
    gst_head: null,
    gst_rate: null,
    tds_section: null,
    tds_rate: null,
    tds_base: null,
    bill_reference: null,
    narration: null,
    concept_tags: ['customer_advance'] as ConceptTag[],
    requires_source_document: false,
    source_document_type: null,
    ...extra,
  };
}

const juneEntries: Entry[] = [
  // Goods advance from Bengaluru Boutique, then the invoice that adjusts it.
  leg(1, 'Receipt', 'HDFC Bank — 1234', 'Dr', 45000, { bill_reference: 'ADV-C01 (Advance)' }),
  leg(1, 'Receipt', 'Bengaluru Boutique', 'Cr', 45000, { bill_reference: 'ADV-C01 (Advance)' }),
  leg(2, 'Sales', 'Bengaluru Boutique', 'Dr', 70800, { bill_reference: 'ADV-C01 (Advance), INV-3001' }),
  leg(2, 'Sales', 'Sales', 'Cr', 60000, { bill_reference: 'ADV-C01 (Advance), INV-3001' }),
  leg(2, 'Sales', 'Output CGST', 'Cr', 5400, { bill_reference: 'ADV-C01 (Advance), INV-3001', gst_head: 'CGST', gst_rate: 9 }),
  leg(2, 'Sales', 'Output SGST', 'Cr', 5400, { bill_reference: 'ADV-C01 (Advance), INV-3001', gst_head: 'SGST', gst_rate: 9 }),
  // Service advance from Karnataka Emporium (GST on the advance, rulebook 9B).
  leg(3, 'Receipt', 'HDFC Bank — 1234', 'Dr', 23600, { bill_reference: 'ADV-C02 (Advance)' }),
  leg(3, 'Receipt', 'Karnataka Emporium', 'Cr', 20000, { bill_reference: 'ADV-C02 (Advance)' }),
  leg(3, 'Receipt', 'Output CGST on Advance', 'Cr', 1800, { bill_reference: 'ADV-C02 (Advance)', gst_head: 'CGST', gst_rate: 9 }),
  leg(3, 'Receipt', 'Output SGST on Advance', 'Cr', 1800, { bill_reference: 'ADV-C02 (Advance)', gst_head: 'SGST', gst_rate: 9 }),
  leg(4, 'Sales', 'Karnataka Emporium', 'Dr', 23600, { bill_reference: 'ADV-C02 (Advance), INV-3002' }),
  leg(4, 'Sales', 'Sales', 'Cr', 20000, { bill_reference: 'ADV-C02 (Advance), INV-3002' }),
  leg(4, 'Sales', 'Output CGST', 'Cr', 1800, { bill_reference: 'ADV-C02 (Advance), INV-3002', gst_head: 'CGST', gst_rate: 9 }),
  leg(4, 'Sales', 'Output SGST', 'Cr', 1800, { bill_reference: 'ADV-C02 (Advance), INV-3002', gst_head: 'SGST', gst_rate: 9 }),
  // Rulebook 9B step 3: the advance GST is reversed against the invoice.
  leg(5, 'Journal', 'Output CGST on Advance', 'Dr', 1800, { bill_reference: 'INV-3002', gst_head: 'CGST', gst_rate: 9 }),
  leg(5, 'Journal', 'Output SGST on Advance', 'Dr', 1800, { bill_reference: 'INV-3002', gst_head: 'SGST', gst_rate: 9 }),
  leg(5, 'Journal', 'Karnataka Emporium', 'Cr', 3600, { bill_reference: 'INV-3002' }),
  // Supplier advance to Mumbai Suppliers, then the bill that adjusts it.
  leg(6, 'Payment', 'Mumbai Suppliers', 'Dr', 15000, { bill_reference: 'ADV-S01 (Advance)' }),
  leg(6, 'Payment', 'HDFC Bank — 1234', 'Cr', 15000, { bill_reference: 'ADV-S01 (Advance)' }),
  leg(7, 'Purchase', 'Purchases', 'Dr', 22000, { bill_reference: 'ADV-S01 (Advance), MS/990' }),
  leg(7, 'Purchase', 'Input IGST', 'Dr', 3960, { bill_reference: 'ADV-S01 (Advance), MS/990', gst_head: 'IGST', gst_rate: 18 }),
  leg(7, 'Purchase', 'Mumbai Suppliers', 'Cr', 25960, { bill_reference: 'ADV-S01 (Advance), MS/990' }),
];

const juneBatch: GeneratedExercise = {
  scenario: 'June 2025.',
  difficulty_level: 'L4',
  variant: 'A',
  transactions: [
    { sequence: 1, description: 'On 02-Jun-2025, Bengaluru Boutique paid Rs 45,000 into the bank as an advance against a future order.' },
    { sequence: 2, description: 'On 05-Jun-2025, you raised Sales Invoice INV-3001 on Bengaluru Boutique, adjusting advance ADV-C01.' },
    { sequence: 3, description: 'On 08-Jun-2025, Karnataka Emporium paid Rs 23,600 into the bank as an advance for services.' },
    { sequence: 4, description: 'On 10-Jun-2025, you raised Sales Invoice INV-3002 on Karnataka Emporium, adjusting advance ADV-C02.' },
    { sequence: 5, description: 'On 10-Jun-2025, reverse the Output CGST on Advance Rs 1,800 and Output SGST on Advance Rs 1,800 against Karnataka Emporium, Rs 3,600 against INV-3002.' },
    { sequence: 6, description: 'On 12-Jun-2025, you paid Mumbai Suppliers Rs 15,000 as an advance.' },
    { sequence: 7, description: 'On 15-Jun-2025, a bill arrived from Mumbai Suppliers (MS/990), adjusting advance ADV-S01.' },
  ],
  answer_key: { entries: juneEntries },
};

const legsOf = (sequence: number) => juneEntries.filter((entry) => entry.sequence === sequence);
const descriptionOf = (sequence: number) => juneBatch.transactions.find((transaction) => transaction.sequence === sequence)!.description;

describe('parseBillReferences / documentNumberOf: the reference a document is numbered by', () => {
  it('classifies each reference and ignores commas inside an annotation', () => {
    expect(parseBillReferences('ADV-C01 (Advance), INV-3001')).toEqual([
      { ref: 'ADV-C01', kind: 'advance' },
      { ref: 'INV-3001', kind: 'bill' },
    ]);
    expect(parseBillReferences('INV-2231 (Against Ref, part payment)')).toEqual([{ ref: 'INV-2231', kind: 'against', partPayment: true }]);
    expect(parseBillReferences('Against Ref INV-005')).toEqual([{ ref: 'INV-005', kind: 'against' }]);
    expect(parseBillReferences('New Ref INV-062')).toEqual([{ ref: 'INV-062', kind: 'bill', newRef: true }]);
    expect(parseBillReferences('On Account')).toEqual([{ ref: 'On Account', kind: 'on_account' }]);
    expect(parseBillReferences('MS/920, MS/945 (Against Ref, full settlement)')).toEqual([
      { ref: 'MS/920', kind: 'bill' },
      { ref: 'MS/945', kind: 'against' },
    ]);
  });

  it('numbers a document by its own reference, never by the advance it adjusts', () => {
    expect(documentNumberOf('ADV-C01 (Advance), INV-3001')).toBe('INV-3001');
    expect(documentNumberOf('ADV-S01 (Advance), MS/990')).toBe('MS/990');
    expect(documentNumberOf('INV-3002, ADV-C02 (Against Ref)')).toBe('INV-3002');
    expect(documentNumberOf('INV-062 (New Ref)')).toBe('INV-062');
    expect(documentNumberOf('ADV-C01 (Advance)')).toBeNull();
    expect(documentNumberOf(null)).toBeNull();
  });

  it('still finds the invoice when the advance tag is left off (review finding)', () => {
    expect(documentNumberOf('ADV-C01, INV-3001 (New Ref)')).toBe('INV-3001');
    expect(documentNumberOf('ADV-S01, MS/990')).toBe('MS/990');
    expect(parseBillReferences('ADV-C01')).toEqual([{ ref: 'ADV-C01', kind: 'advance' }]);
  });

  it('keeps splitBillReferences and normalizeBillReference stable, and strips "Ref" prefixes', () => {
    expect(splitBillReferences('ADV-C01 (Advance), INV-3001')).toEqual(['ADV-C01', 'INV-3001']);
    expect(splitBillReferences('Against INV-003 (part)')).toEqual(['INV-003']);
    expect(normalizeBillReference('Against Ref INV-005')).toBe('inv005');
    expect(normalizeBillReference('New Ref INV-062')).toBe('inv062');
    expect(normalizeBillReference('INV-062 (New Ref)')).toBe('inv062');
  });
});

describe('printed documents carry the document number (Praveen, June 2025)', () => {
  it('sales invoices print INV-3001 and INV-3002, not the advance references', () => {
    expect(buildSalesInvoiceContent(legsOf(2), descriptionOf(2), 'Blossom Retail Pvt Ltd').invoiceNumber).toBe('INV-3001');
    expect(buildSalesInvoiceContent(legsOf(4), descriptionOf(4), 'Blossom Retail Pvt Ltd').invoiceNumber).toBe('INV-3002');
  });

  it('the sales register rows carry the same numbers', () => {
    const plan = applyDocumentsMode(juneBatch, { companyName: 'Blossom Retail Pvt Ltd', monthLabel: 'June 2025' });
    expect(plan.salesRegister?.rows.map((row) => row.invoiceNumber)).toEqual(['INV-3001', 'INV-3002']);
  });

  it('pointer lines name the document number, and never call an advance a bill', () => {
    const generated = applyDocumentsMode(juneBatch, { companyName: 'Blossom Retail Pvt Ltd', monthLabel: 'June 2025' }).generated;
    const line = (sequence: number) => generated.transactions.find((t) => t.sequence === sequence)!.description;
    expect(line(2)).toBe('On 05-Jun-2025, you raised Sales Invoice INV-3001 on Bengaluru Boutique: post it from the attached sales invoice.');
    expect(line(4)).toBe('On 10-Jun-2025, you raised Sales Invoice INV-3002 on Karnataka Emporium: post it from the attached sales invoice.');
    expect(line(7)).toBe('On 15-Jun-2025, an invoice arrived from Mumbai Suppliers (Ref MS/990): post it from the attached invoice.');
    expect(line(1)).toBe('On 02-Jun-2025, a receipt from Bengaluru Boutique (Ref ADV-C01) landed in the bank: post it from the bank statement.');
    expect(line(6)).toBe('On 12-Jun-2025, a payment to Mumbai Suppliers (Ref ADV-S01) went out from the bank: post it from the bank statement.');
  });

  it('a sale that adjusts a GST-bearing (service) advance is not described as trading goods', () => {
    const plan = applyDocumentsMode(juneBatch, { companyName: 'Blossom Retail Pvt Ltd', monthLabel: 'June 2025' });
    const karnataka = plan.salesInvoices.find((invoice) => invoice.sequence === 4)!.content;
    const bengaluru = plan.salesInvoices.find((invoice) => invoice.sequence === 2)!.content;
    expect(karnataka.lineItems[0].description).not.toMatch(/goods/i);
    expect(bengaluru.lineItems[0].description).toBe('Trading goods as per order');
  });

  it('the vendor invoice is generated and checked against MS/990', () => {
    const input = { legs: legsOf(7), transactionDescription: descriptionOf(7) };
    const system = buildVendorInvoicePrompt(input).messages[0].content;
    expect(system).toContain('invoiceNumber: "MS/990" exactly');
    const content = {
      vendorName: 'Mumbai Suppliers',
      vendorGSTIN: '27AABCM1234F1ZX',
      invoiceNumber: 'MS/990',
      invoiceDate: '15-Jun-2025',
      lineItems: [{ description: 'Trading goods', quantity: 1, rate: 22000, amount: 22000 }],
      taxBreakup: { cgst_amount: null, sgst_amount: null, igst_amount: 3960 },
      totalAmount: 25960,
    };
    expect(checkVendorInvoiceContent(content, input)).toBeNull();
    expect(checkVendorInvoiceContent({ ...content, invoiceNumber: 'ADV-S01' }, input)).toContain('must be exactly "MS/990"');
  });
});

describe('bill state and numbering treat the advance as adjusted, not raised', () => {
  it('open bills: the advance is consumed by the invoice that adjusts it, not by the customer\'s older bill', () => {
    // May: Bengaluru Boutique already owes Rs 10,000 on INV-2900.
    const may = {
      entries: [
        leg(1, 'Sales', 'Bengaluru Boutique', 'Dr', 10000, { bill_reference: 'INV-2900' }),
        leg(1, 'Sales', 'Sales', 'Cr', 10000, { bill_reference: 'INV-2900' }),
      ],
    } as AnswerKey;
    const bills = openBillsFromKeys([may, { entries: juneEntries } as AnswerKey]);
    expect(bills.find((bill) => bill.ref === 'INV-2900')).toEqual({ party: 'Bengaluru Boutique', ref: 'INV-2900', open: 10000, side: 'receivable' });
    expect(bills.find((bill) => bill.ref === 'INV-3001')).toEqual({ party: 'Bengaluru Boutique', ref: 'INV-3001', open: 25800, side: 'receivable' });
    expect(bills.find((bill) => bill.ref === 'MS/990')).toEqual({ party: 'Mumbai Suppliers', ref: 'MS/990', open: 10960, side: 'payable' });
    expect(bills.some((bill) => /^ADV-/.test(bill.ref))).toBe(false);
    // Karnataka Emporium: the 20,000 advance base is adjusted by the invoice
    // and the 3,600 GST part by the step-3 reversal journal: nothing open.
    expect(bills.some((bill) => bill.ref === 'INV-3002')).toBe(false);
  });

  it('uniqueness counts the numbers a document or an advance raises, not the advance a document adjusts', () => {
    // 2026-09-17 audit: advance numbers are raised by the receipt or payment
    // and count too; leading zeros are ignored (ADV-C01 = ADV-C1).
    const prior = priorBillReferences([{ entries: juneEntries } as AnswerKey]);
    expect([...prior].sort()).toEqual(['advc1', 'advc2', 'advs1', 'inv3001', 'inv3002', 'ms990']);
    const july: GeneratedExercise = {
      ...juneBatch,
      answer_key: {
        entries: [
          leg(1, 'Sales', 'Delhi Bazaar', 'Dr', 11800, { bill_reference: 'ADV-C01 (Advance), INV-3101' }),
          leg(1, 'Sales', 'Sales', 'Cr', 10000, { bill_reference: 'ADV-C01 (Advance), INV-3101' }),
        ],
      },
    };
    expect(checkBillNumberUniqueness(july, prior)).toBeNull();
  });

  it('rejects a sale or purchase that adjusts an advance but names no document number of its own', () => {
    const noNumber: GeneratedExercise = {
      ...juneBatch,
      answer_key: {
        entries: [
          leg(1, 'Sales', 'Delhi Bazaar', 'Dr', 11800, { bill_reference: 'ADV-C09 (Advance)' }),
          leg(1, 'Sales', 'Sales', 'Cr', 10000, { bill_reference: 'ADV-C09 (Advance)' }),
        ],
      },
    };
    expect(checkBillNumberUniqueness(noNumber, new Set())).toContain('names no invoice or bill number of its own');
  });

  it('rejects a sale naming two numbers of its own (an untagged settled bill next to the invoice)', () => {
    const twoNumbers: GeneratedExercise = {
      ...juneBatch,
      answer_key: {
        entries: [
          leg(1, 'Sales', 'Delhi Bazaar', 'Dr', 11800, { bill_reference: 'INV-2999, INV-3102' }),
          leg(1, 'Sales', 'Sales', 'Cr', 10000, { bill_reference: 'INV-2999, INV-3102' }),
        ],
      },
    };
    expect(checkBillNumberUniqueness(twoNumbers, new Set())).toContain('a document has exactly one');
  });

  it('a journal allocated against two open bills clears them in order', () => {
    const bills = openBillsFromKeys([
      {
        entries: [
          leg(1, 'Sales', 'Delhi Bazaar', 'Dr', 10000, { bill_reference: 'INV-4001' }),
          leg(1, 'Sales', 'Sales', 'Cr', 10000, { bill_reference: 'INV-4001' }),
          leg(2, 'Sales', 'Delhi Bazaar', 'Dr', 8000, { bill_reference: 'INV-4002' }),
          leg(2, 'Sales', 'Sales', 'Cr', 8000, { bill_reference: 'INV-4002' }),
          leg(3, 'Journal', 'Bad Debts Written Off', 'Dr', 13000, { bill_reference: 'INV-4001, INV-4002' }),
          leg(3, 'Journal', 'Delhi Bazaar', 'Cr', 13000, { bill_reference: 'INV-4001, INV-4002' }),
        ],
      } as AnswerKey,
    ]);
    expect(bills.some((bill) => bill.ref === 'INV-4001')).toBe(false);
    expect(bills.find((bill) => bill.ref === 'INV-4002')?.open).toBe(5000);
  });
});
