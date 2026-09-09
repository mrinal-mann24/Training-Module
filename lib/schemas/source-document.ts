import { z } from 'zod';

// sales_invoice and month_end_note arrived with documents mode (2026-09-09):
// once a learner has mastered enough concepts every transaction is delivered
// as paperwork — our own sales invoice / cash memo copy, and a month-end
// notes sheet for the journals that have no third-party document.
//
// sales_register (2026-09-09): AI Accountant's sales screen takes CSV/XLS,
// not PDFs, so a documents-mode batch with any sale also ships one CSV
// register of that month's sales invoices, built by code from the same
// figures as the invoices. The only non-PDF document type.
export const SOURCE_DOCUMENT_TYPES = ['vendor_invoice', 'bank_statement', 'sales_invoice', 'month_end_note', 'sales_register'] as const;
export type SourceDocumentType = (typeof SOURCE_DOCUMENT_TYPES)[number];

// Storage file format per document type. Everything renders to PDF except
// the sales register, which is a CSV for upload into AI Accountant.
export const SOURCE_DOCUMENT_FILE_FORMAT: Record<SourceDocumentType, { extension: 'pdf' | 'csv'; contentType: string }> = {
  vendor_invoice: { extension: 'pdf', contentType: 'application/pdf' },
  bank_statement: { extension: 'pdf', contentType: 'application/pdf' },
  sales_invoice: { extension: 'pdf', contentType: 'application/pdf' },
  month_end_note: { extension: 'pdf', contentType: 'application/pdf' },
  sales_register: { extension: 'csv', contentType: 'text/csv' },
};

// Content schemas below validate only what a real physical document would
// show — raw commercial facts and figures a vendor/bank actually prints.
// They never state the accounting classification the learner is meant to
// derive (e.g. an invoice carries the GST amount charged, never a label like
// "post this as IGST Payable") — that judgment is the exercise itself. This
// boundary is enforced in the generation prompt (lib/llm/prompts/source-document.ts),
// not just assumed here.

const VendorInvoiceLineItemSchema = z.object({
  description: z.string(),
  quantity: z.number(),
  rate: z.number(),
  amount: z.number(),
});

// Raw stated figures as they'd appear printed on the invoice — not a
// classification. A learner still has to determine CGST+SGST vs. IGST
// applicability themselves; this schema only carries whatever the vendor
// actually printed.
const TaxBreakupSchema = z.object({
  cgst_amount: z.number().nullable(),
  sgst_amount: z.number().nullable(),
  igst_amount: z.number().nullable(),
});

export const VendorInvoiceContentSchema = z.object({
  vendorName: z.string(),
  vendorGSTIN: z.string(),
  // Set by code from the party directory after generation (2026-09-09);
  // optional so documents stored before then still parse and re-render.
  vendorAddress: z.string().optional(),
  invoiceNumber: z.string(),
  invoiceDate: z.string(),
  lineItems: z.array(VendorInvoiceLineItemSchema).min(1),
  taxBreakup: TaxBreakupSchema,
  totalAmount: z.number(),
});
export type VendorInvoiceContent = z.infer<typeof VendorInvoiceContentSchema>;

const BankStatementTransactionSchema = z.object({
  date: z.string(),
  narration: z.string(),
  debit: z.number().nullable(),
  credit: z.number().nullable(),
  balance: z.number(),
});

export const BankStatementContentSchema = z.object({
  accountHolderName: z.string(),
  period: z.string(),
  transactions: z.array(BankStatementTransactionSchema).min(1),
});
export type BankStatementContent = z.infer<typeof BankStatementContentSchema>;

// Our own outgoing invoice (or cash memo, for a counter sale). Built by code
// from the answer key — never by the model — so every figure is exact.
export const SalesInvoiceContentSchema = z.object({
  sellerName: z.string(),
  sellerGSTIN: z.string(),
  sellerAddress: z.string(),
  buyerName: z.string(),
  // Buyer block from the party directory (2026-09-09); optional so older
  // stored invoices still parse. GSTIN is null on a cash memo.
  buyerAddress: z.string().optional(),
  buyerGSTIN: z.string().nullable().optional(),
  placeOfSupply: z.string(),
  invoiceNumber: z.string(),
  invoiceDate: z.string(),
  isCashMemo: z.boolean(),
  lineItems: z.array(VendorInvoiceLineItemSchema).min(1),
  taxBreakup: TaxBreakupSchema,
  totalAmount: z.number(),
});
export type SalesInvoiceContent = z.infer<typeof SalesInvoiceContentSchema>;

// The owner's month-end instructions (accruals, prepaid write-offs, GST
// set-off, suspense clearing, returns): the transactions that have no
// third-party document in real life either. The text is the batch's own
// wording, figures included, moved out of the brief and onto a sheet.
export const MonthEndNotesContentSchema = z.object({
  companyName: z.string(),
  period: z.string(),
  notes: z.array(z.object({ number: z.number().int().positive(), date: z.string(), text: z.string() })).min(1),
});
export type MonthEndNotesContent = z.infer<typeof MonthEndNotesContentSchema>;

// One row per sales invoice / cash memo of the month, for upload into AI
// Accountant's sales screen. Derived by code from the batch's
// SalesInvoiceContent, so every figure equals the invoice PDF and the key.
export const SalesRegisterRowSchema = z.object({
  invoiceNumber: z.string(),
  invoiceDate: z.string(),
  customerName: z.string(),
  customerGSTIN: z.string().nullable(),
  placeOfSupply: z.string(),
  isCashMemo: z.boolean(),
  taxableValue: z.number(),
  cgst: z.number(),
  sgst: z.number(),
  igst: z.number(),
  total: z.number(),
});
export type SalesRegisterRow = z.infer<typeof SalesRegisterRowSchema>;

export const SalesRegisterContentSchema = z.object({
  sellerName: z.string(),
  sellerGSTIN: z.string(),
  period: z.string(),
  rows: z.array(SalesRegisterRowSchema).min(1),
});
export type SalesRegisterContent = z.infer<typeof SalesRegisterContentSchema>;

// Discriminated union validated against the raw LLM response for a single
// source-document generation call — doc_type picks which content shape is
// expected, so a mismatched pairing fails validation rather than silently
// coercing.
export const GeneratedSourceDocumentSchema = z.discriminatedUnion('doc_type', [
  z.object({ doc_type: z.literal('vendor_invoice'), content: VendorInvoiceContentSchema }),
  z.object({ doc_type: z.literal('bank_statement'), content: BankStatementContentSchema }),
  z.object({ doc_type: z.literal('sales_invoice'), content: SalesInvoiceContentSchema }),
  z.object({ doc_type: z.literal('month_end_note'), content: MonthEndNotesContentSchema }),
  z.object({ doc_type: z.literal('sales_register'), content: SalesRegisterContentSchema }),
]);
export type GeneratedSourceDocument = z.infer<typeof GeneratedSourceDocumentSchema>;
