import { renderToBuffer } from '@react-pdf/renderer';
import type { DocumentProps } from '@react-pdf/renderer';
import { VendorInvoiceDocument } from '@/lib/documents/templates/vendor-invoice';
import { VendorInvoiceDocumentB } from '@/lib/documents/templates/vendor-invoice-b';
import { VendorInvoiceDocumentC } from '@/lib/documents/templates/vendor-invoice-c';
import { VendorInvoiceDocumentD } from '@/lib/documents/templates/vendor-invoice-d';
import { VendorInvoiceDocumentE } from '@/lib/documents/templates/vendor-invoice-e';
import { VendorInvoiceDocumentF } from '@/lib/documents/templates/vendor-invoice-f';
import { BankStatementDocument } from '@/lib/documents/templates/bank-statement';
import { BankStatementHdfcDocument } from '@/lib/documents/templates/bank-statement-hdfc';
import { SalesInvoiceDocument } from '@/lib/documents/templates/sales-invoice';
import { MonthEndNotesDocument } from '@/lib/documents/templates/month-end-notes';
import { pickFormatIndex } from '@/lib/documents/pick-template';
import { renderSalesRegisterCsv } from '@/lib/documents/build-sales-register';
import { SOURCE_DOCUMENT_FILE_FORMAT } from '@/lib/schemas/source-document';
import type { GeneratedSourceDocument, VendorInvoiceContent, BankStatementContent } from '@/lib/schemas/source-document';

// Index order is part of the determinism contract: reordering these arrays
// changes which format an existing document re-renders in. Append only.
const VENDOR_INVOICE_FORMATS: ((props: { content: VendorInvoiceContent }) => React.ReactElement<DocumentProps>)[] = [
  VendorInvoiceDocument,
  VendorInvoiceDocumentB,
  VendorInvoiceDocumentC,
  VendorInvoiceDocumentD,
  VendorInvoiceDocumentE,
  VendorInvoiceDocumentF,
];

const BANK_STATEMENT_FORMATS: ((props: { content: BankStatementContent }) => React.ReactElement<DocumentProps>)[] = [
  BankStatementDocument,
  BankStatementHdfcDocument,
];

// Deterministic, code-based rendering — the same GeneratedSourceDocument and
// seed always produce the same PDF bytes. No LLM involvement in this step;
// the LLM's output ends at the validated structured content in
// generated.content. The seed (exercise id + transaction sequence) rotates
// the visual format across documents (Phase 4, spec 16) without touching
// the data.
export async function renderSourceDocumentPdf(
  generated: GeneratedSourceDocument,
  formatSeed: string,
): Promise<Buffer> {
  const formatIndex = pickFormatIndex(generated.doc_type, formatSeed);
  let element: React.ReactElement<DocumentProps>;
  switch (generated.doc_type) {
    case 'vendor_invoice':
      element = VENDOR_INVOICE_FORMATS[formatIndex]({ content: generated.content });
      break;
    case 'bank_statement':
      element = BANK_STATEMENT_FORMATS[formatIndex]({ content: generated.content });
      break;
    case 'sales_invoice':
      element = SalesInvoiceDocument({ content: generated.content });
      break;
    case 'month_end_note':
      element = MonthEndNotesDocument({ content: generated.content });
      break;
    case 'sales_register':
      throw new Error('sales_register is a CSV, not a PDF — use renderSourceDocument.');
  }

  return renderToBuffer(element);
}

export type RenderedSourceDocument = {
  bytes: Buffer;
  extension: 'pdf' | 'csv';
  contentType: string;
};

// Format-aware entry point: PDF for every document type except the sales
// register, which AI Accountant only accepts as CSV. Callers use extension
// and contentType for the storage path and upload, so a new non-PDF type
// only ever has to be added here and in SOURCE_DOCUMENT_FILE_FORMAT.
export async function renderSourceDocument(
  generated: GeneratedSourceDocument,
  formatSeed: string,
): Promise<RenderedSourceDocument> {
  const format = SOURCE_DOCUMENT_FILE_FORMAT[generated.doc_type];
  const bytes =
    generated.doc_type === 'sales_register'
      ? renderSalesRegisterCsv(generated.content)
      : await renderSourceDocumentPdf(generated, formatSeed);
  return { bytes, extension: format.extension, contentType: format.contentType };
}
