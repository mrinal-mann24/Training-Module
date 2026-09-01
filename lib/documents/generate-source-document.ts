import { getTracedStructuredCompletion } from '@/lib/llm/tracing';
import {
  buildBankStatementBatchPrompt,
  buildBankStatementBatchRetryPrompt,
  buildVendorInvoicePrompt,
  buildVendorInvoiceRetryPrompt,
  deriveInvoiceFigures,
  extractTransactionDate,
  formatInvoiceDate,
  type BankStatementLineInput,
  type VendorInvoiceInput,
} from '@/lib/llm/prompts/source-document';
import {
  GeneratedSourceDocumentSchema,
  type GeneratedSourceDocument,
  type VendorInvoiceContent,
} from '@/lib/schemas/source-document';

const MAX_ATTEMPTS = 3;

const AMOUNT_TOLERANCE = 0.01;

function amountMatches(actual: number | null, expected: number | null): boolean {
  if (expected === null) {
    // Unused tax heads may print as null or an explicit 0 — both fine.
    return actual === null || Math.abs(actual) < AMOUNT_TOLERANCE;
  }
  return actual !== null && Math.abs(actual - expected) < AMOUNT_TOLERANCE;
}

// Deterministic figure/date validation for a generated invoice — the same
// role the line-count check plays for the bank statement. Every delivered
// invoice in the first live intern batches contradicted its answer key
// (wrong totals, missing IGST, all dated "2024-01-15"); with this check a
// document-vs-answer-key contradiction can no longer be rendered at all.
// Exported for tests.
export function checkVendorInvoiceContent(
  content: VendorInvoiceContent,
  input: VendorInvoiceInput,
): string | null {
  const figures = deriveInvoiceFigures(input.legs);
  const violations: string[] = [];

  const lineSum = content.lineItems.reduce((sum, item) => sum + item.amount, 0);
  if (Math.abs(lineSum - figures.base) >= AMOUNT_TOLERANCE) {
    violations.push(`lineItems sum to ${lineSum} but must sum to exactly ${figures.base}.`);
  }
  if (Math.abs(content.totalAmount - figures.total) >= AMOUNT_TOLERANCE) {
    violations.push(`totalAmount is ${content.totalAmount} but must be exactly ${figures.total}.`);
  }
  if (!amountMatches(content.taxBreakup.cgst_amount, figures.cgst)) {
    violations.push(`cgst_amount is ${content.taxBreakup.cgst_amount} but must be ${figures.cgst ?? 'null'}.`);
  }
  if (!amountMatches(content.taxBreakup.sgst_amount, figures.sgst)) {
    violations.push(`sgst_amount is ${content.taxBreakup.sgst_amount} but must be ${figures.sgst ?? 'null'}.`);
  }
  if (!amountMatches(content.taxBreakup.igst_amount, figures.igst)) {
    violations.push(`igst_amount is ${content.taxBreakup.igst_amount} but must be ${figures.igst ?? 'null'}.`);
  }

  const expectedDate = extractTransactionDate(input.transactionDescription);
  if (expectedDate) {
    const printed = extractTransactionDate(content.invoiceDate) ?? isoDate(content.invoiceDate);
    if (
      !printed ||
      printed.year !== expectedDate.year ||
      printed.monthIndex !== expectedDate.monthIndex ||
      printed.day !== expectedDate.day
    ) {
      violations.push(
        `invoiceDate is "${content.invoiceDate}" but must be exactly "${formatInvoiceDate(expectedDate)}" (the transaction's own date).`,
      );
    }
  }

  const vendorNorm = content.vendorName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const expectedNorm = figures.vendorAccount.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!vendorNorm.includes(expectedNorm) && !expectedNorm.includes(vendorNorm)) {
    violations.push(`vendorName is "${content.vendorName}" but must be "${figures.vendorAccount}".`);
  }

  return violations.length > 0 ? violations.join(' ') : null;
}

// "2026-05-06"-style dates, which extractTransactionDate's DD-first patterns
// don't cover.
function isoDate(value: string): { day: number; monthIndex: number; year: number } | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  return match
    ? { year: Number(match[1]), monthIndex: Number(match[2]) - 1, day: Number(match[3]) }
    : null;
}

// Generates one vendor invoice, grounded on the transaction's complete leg
// set + description and validated figure-by-figure against them. Same
// bounded validate-and-retry pattern as every LLM call in this codebase.
export async function generateVendorInvoiceDocument(
  learnerId: string,
  input: VendorInvoiceInput,
): Promise<GeneratedSourceDocument> {
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { messages, jsonSchema } =
      lastError === null
        ? buildVendorInvoicePrompt(input)
        : buildVendorInvoiceRetryPrompt(input, lastError);

    const raw = await getTracedStructuredCompletion({
      messages,
      jsonSchema,
      traceName: 'source-document-generation',
      learnerId,
      callType: 'source-document-generation',
      // Documents are simple structured content — a faster model (set via
      // OPENROUTER_DOCUMENT_MODEL) cuts the batch tail dramatically; falls
      // back to the main OPENROUTER_MODEL when unset.
      model: process.env.OPENROUTER_DOCUMENT_MODEL,
      extraMetadata: { docType: 'vendor_invoice', transactionSequence: input.legs[0].sequence },
    });

    const parsed = GeneratedSourceDocumentSchema.safeParse(raw);

    if (parsed.success) {
      if (parsed.data.doc_type !== 'vendor_invoice') {
        lastError = `Expected doc_type "vendor_invoice", got "${parsed.data.doc_type}".`;
        continue;
      }
      const figureError = checkVendorInvoiceContent(parsed.data.content, input);
      if (figureError !== null) {
        lastError = figureError;
        continue;
      }
      return parsed.data;
    }

    lastError = parsed.error.message;
  }

  throw new Error(
    `Vendor invoice generation failed validation after ${MAX_ATTEMPTS} attempts: ${lastError}`,
  );
}

// Generates ONE combined bank statement for all of a batch's bank-side
// transactions — a real statement is a single period document listing every
// movement, never one PDF per transaction (live intern feedback,
// 2026-09-01). Same bounded validate-and-retry pattern as above; the result
// is additionally checked to carry exactly one line per input transaction so
// a statement that silently drops or invents lines is retried, not rendered.
export async function generateBankStatementDocument(
  learnerId: string,
  lines: BankStatementLineInput[],
  // The statement's account holder — pinned to the learner's real company so
  // the PDF never invents one (live 2026-09-01: "Bank Statement — ABC
  // Trading Co." on a Blossom Retail batch).
  companyName: string,
): Promise<GeneratedSourceDocument> {
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { messages, jsonSchema } =
      lastError === null
        ? buildBankStatementBatchPrompt(lines, companyName)
        : buildBankStatementBatchRetryPrompt(lines, companyName, lastError);

    const raw = await getTracedStructuredCompletion({
      messages,
      jsonSchema,
      traceName: 'source-document-generation',
      learnerId,
      callType: 'source-document-generation',
      // Documents are simple structured content — a faster model (set via
      // OPENROUTER_DOCUMENT_MODEL) cuts the batch tail dramatically; falls
      // back to the main OPENROUTER_MODEL when unset.
      model: process.env.OPENROUTER_DOCUMENT_MODEL,
      extraMetadata: {
        docType: 'bank_statement',
        transactionSequences: lines.map((line) => line.entry.sequence).join(','),
      },
    });

    const parsed = GeneratedSourceDocumentSchema.safeParse(raw);

    if (parsed.success) {
      if (parsed.data.doc_type !== 'bank_statement') {
        lastError = `Expected doc_type "bank_statement", got "${parsed.data.doc_type}".`;
        continue;
      }
      if (parsed.data.content.transactions.length !== lines.length) {
        lastError = `The statement has ${parsed.data.content.transactions.length} line(s) but ${lines.length} transaction(s) were provided — produce exactly one statement line per listed transaction.`;
        continue;
      }
      return parsed.data;
    }

    lastError = parsed.error.message;
  }

  throw new Error(
    `Bank statement generation failed validation after ${MAX_ATTEMPTS} attempts: ${lastError}`,
  );
}
