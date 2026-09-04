import { getTracedStructuredCompletion } from '@/lib/llm/tracing';
import type { BankStatementContent } from '@/lib/schemas/source-document';
import {
  buildBankStatementBatchPrompt,
  buildBankStatementBatchRetryPrompt,
  buildVendorInvoicePrompt,
  buildVendorInvoiceRetryPrompt,
  deriveInvoiceFigures,
  extractTransactionDate,
  formatInvoiceDate,
  type BankStatementLineInput,
  type VendorInvoiceFigures,
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

function sortedAmounts(values: number[]): string {
  return [...values].sort((a, b) => a - b).map((value) => value.toFixed(2)).join('|');
}

// A goods purchase may print several stock lines (cotton, polyester) that all
// post to Purchases. A service or expense bill may not: Praveen posted
// MA/206's two printed lines ("Professional consultation 10,000", "Audit and
// compliance review 5,000") to two ledgers, exactly as the document invited,
// and was scored AMOUNT_WRONG + ACCOUNT_WRONG against a key with one
// 15,000 leg (2026-09-04). One expense leg, one printed line.
const GOODS_ACCOUNT_PATTERN = /\b(purchase|purchases|goods|stock|material|materials|inventory)\b/i;

function singleLineRequired(figures: VendorInvoiceFigures): boolean {
  return figures.baseLines.length === 1 && !GOODS_ACCOUNT_PATTERN.test(figures.baseLines[0].account);
}

function lineAmountsMatchLegs(content: VendorInvoiceContent, figures: VendorInvoiceFigures): boolean {
  return (
    sortedAmounts(content.lineItems.map((item) => item.amount)) ===
    sortedAmounts(figures.baseLines.map((line) => line.amount))
  );
}

function descriptionTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((token) => token.length > 3 && !['charges', 'charge', 'expenses', 'expense', 'account'].includes(token)),
  );
}

// A bill with several expense legs (goods + freight) must print one line per
// leg with that leg's exact amount. The model is told so, but a wrong split
// with the right total slipped through the sum check on Garima's Level 5
// MS-3102 (invoice 17,000 goods + 20,000 freight vs key 35,000 + 2,000;
// 2026-09-04). This realigns deterministically: each leg becomes a line
// carrying its own amount, keeping the model's wording where a line clearly
// describes that leg and falling back to the account name otherwise.
// Exported for tests.
export function alignLineItemsToLegs(content: VendorInvoiceContent, figures: VendorInvoiceFigures): VendorInvoiceContent {
  if (singleLineRequired(figures) && content.lineItems.length > 1) {
    const [line] = figures.baseLines;
    return {
      ...content,
      lineItems: [{ description: content.lineItems[0].description, quantity: 1, rate: line.amount, amount: line.amount }],
    };
  }
  if (figures.baseLines.length < 2 || lineAmountsMatchLegs(content, figures)) {
    return content;
  }
  // Pass 1: a model line whose wording names the leg ("Freight and handling
  // charges" for Freight & Delivery Charges) keeps that leg. Pass 2: the
  // remaining lines fill the remaining legs in order (the goods line lands on
  // Purchases). Anything still unmatched prints the account name.
  const remaining = [...content.lineItems];
  const chosen: (string | null)[] = figures.baseLines.map((line) => {
    const accountTokens = descriptionTokens(line.account);
    const index = remaining.findIndex((item) => [...descriptionTokens(item.description)].some((token) => accountTokens.has(token)));
    return index === -1 ? null : remaining.splice(index, 1)[0].description;
  });
  const lineItems = figures.baseLines.map((line, position) => {
    const description = chosen[position] ?? remaining.shift()?.description ?? line.account;
    return { description, quantity: 1, rate: line.amount, amount: line.amount };
  });
  return { ...content, lineItems };
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
  if (singleLineRequired(figures) && content.lineItems.length !== 1) {
    violations.push(`lineItems must be exactly one line for "${figures.baseLines[0].account}" with amount ${figures.baseLines[0].amount}.`);
  }
  if (figures.baseLines.length >= 2 && !lineAmountsMatchLegs(content, figures)) {
    violations.push(
      `lineItems must be one per component: ${figures.baseLines.map((line) => `${line.account} ${line.amount}`).join(', ')}.`,
    );
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
      const content = alignLineItemsToLegs(parsed.data.content, deriveInvoiceFigures(input.legs));
      const figureError = checkVendorInvoiceContent(content, input);
      if (figureError !== null) {
        lastError = figureError;
        continue;
      }
      return { ...parsed.data, content };
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
// The statement must carry what the answer key expects the learner to read
// off it. Live 2026-09-02 (Praveen, Level 2): the key demanded bill reference
// "KE/2026/018" on a receipt, but the statement line only said
// "NEFT/N26050114/KARNATAKA EMPORIUM/RCP" — the number existed nowhere the
// learner could see, so a correct posting was BILL_REFERENCE_WRONG and the
// coaching quoted an invisible invoice back at him. Each key transaction must
// map to exactly one statement line on the right side, for the right amount,
// on its own date, whose narration contains the bill reference (annotations
// like "(part payment, …)" and the "Against" prefix are not part of the ref).
const BANK_LEDGER_PATTERN = /\b(bank|hdfc|icici|sbi|axis|kotak)\b/i;

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function billReferenceTokens(billReference: string): string[] {
  // Parentheticals are stripped BEFORE splitting: "KE/2026/018 (part payment,
  // ₹30,000 balance outstanding)" carries a comma inside the annotation, and
  // splitting first shredded it into non-references (caught by the test).
  return billReference
    .replace(/\([^)]*\)/g, '')
    .split(/[,;]/)
    .map((ref) => ref.replace(/^\s*against\s+/i, ''))
    .map(normalizeToken)
    .filter((ref) => ref.length > 0);
}

function statementSideFor(entry: BankStatementLineInput['entry']): 'debit' | 'credit' {
  // Money direction from the bank's statement: bank leg Dr = money in
  // (credit on the statement), bank leg Cr = money out (debit). The flagged
  // entry may be the bank leg itself or its counter-leg.
  const bankLegIsDebit = BANK_LEDGER_PATTERN.test(entry.correct_account)
    ? entry.dr_cr === 'Dr'
    : entry.dr_cr === 'Cr';
  return bankLegIsDebit ? 'credit' : 'debit';
}

export function checkBankStatementContent(
  content: BankStatementContent,
  lines: BankStatementLineInput[],
): string | null {
  const violations: string[] = [];
  const claimed = new Set<number>();

  for (const line of lines) {
    const side = statementSideFor(line.entry);
    const index = content.transactions.findIndex((transaction, i) => {
      if (claimed.has(i)) {
        return false;
      }
      const amount = side === 'debit' ? transaction.debit : transaction.credit;
      return amount !== null && Math.abs(amount - line.entry.amount) < AMOUNT_TOLERANCE;
    });
    if (index === -1) {
      violations.push(
        `Exercise item ${line.entry.sequence} needs a statement line with ${side} exactly ${line.entry.amount} (and the other column null), but none was found.`,
      );
      continue;
    }
    claimed.add(index);
    const transaction = content.transactions[index];

    const expectedDate = extractTransactionDate(line.transactionDescription);
    if (expectedDate) {
      const printed = extractTransactionDate(transaction.date) ?? isoDate(transaction.date);
      if (
        !printed ||
        printed.year !== expectedDate.year ||
        printed.monthIndex !== expectedDate.monthIndex ||
        printed.day !== expectedDate.day
      ) {
        violations.push(
          `Exercise item ${line.entry.sequence}'s statement line is dated "${transaction.date}" but must be dated exactly "${formatInvoiceDate(expectedDate)}" (the transaction's own date).`,
        );
      }
    }

    if (line.entry.bill_reference) {
      const narration = normalizeToken(transaction.narration);
      const missing = billReferenceTokens(line.entry.bill_reference).filter((ref) => !narration.includes(ref));
      if (missing.length > 0) {
        violations.push(
          `Exercise item ${line.entry.sequence}'s narration "${transaction.narration}" must contain the bill reference "${line.entry.bill_reference}" verbatim (the learner can only allocate against a reference they can see).`,
        );
      }
    }
  }

  return violations.length === 0 ? null : violations.join(' ');
}

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
      const contentError = checkBankStatementContent(parsed.data.content, lines);
      if (contentError) {
        lastError = contentError;
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
