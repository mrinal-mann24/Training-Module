import { createHash } from 'node:crypto';
import type { SourceDocumentType } from '@/lib/schemas/source-document';

// Phase 4 (spec 16): format rotation for generated documents. Deterministic
// by design — the format index is a hash of the doc type plus a caller
// seed (exercise id + transaction sequence), so the same document always
// re-renders in the same format while different documents across a batch
// and across exercises spread over the available formats. No Math.random
// anywhere in a render path.
export const VENDOR_INVOICE_FORMAT_COUNT = 6;
export const BANK_STATEMENT_FORMAT_COUNT = 2;

// Sales invoices and month-end notes have one layout each (documents mode,
// 2026-09-09); they still go through the same seeded picker so the contract
// is uniform.
const FORMAT_COUNT_BY_DOC_TYPE: Record<SourceDocumentType, number> = {
  vendor_invoice: VENDOR_INVOICE_FORMAT_COUNT,
  bank_statement: BANK_STATEMENT_FORMAT_COUNT,
  sales_invoice: 1,
  month_end_note: 1,
};

export function formatCountForDocType(docType: SourceDocumentType): number {
  return FORMAT_COUNT_BY_DOC_TYPE[docType];
}

export function pickFormatIndex(docType: SourceDocumentType, seed: string): number {
  const digest = createHash('sha256').update(`${docType}:${seed}`).digest();
  // Two bytes give an even spread over any small format count.
  return ((digest[0] << 8) | digest[1]) % formatCountForDocType(docType);
}
