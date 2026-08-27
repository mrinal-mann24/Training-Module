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
import { pickFormatIndex } from '@/lib/documents/pick-template';
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
  const element =
    generated.doc_type === 'vendor_invoice'
      ? VENDOR_INVOICE_FORMATS[formatIndex]({ content: generated.content })
      : BANK_STATEMENT_FORMATS[formatIndex]({ content: generated.content });

  return renderToBuffer(element);
}
