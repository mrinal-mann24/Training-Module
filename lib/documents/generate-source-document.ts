import { getTracedStructuredCompletion } from '@/lib/llm/tracing';
import {
  buildVendorInvoicePrompt,
  buildVendorInvoiceRetryPrompt,
  deriveInvoiceFigures,
  extractTransactionDate,
  formatInvoiceDate,
  type VendorInvoiceFigures,
  type VendorInvoiceInput,
} from '@/lib/llm/prompts/source-document';
import {
  GeneratedSourceDocumentSchema,
  type GeneratedSourceDocument,
  type VendorInvoiceContent,
} from '@/lib/schemas/source-document';
import type { AnswerKeyEntry, GeneratedExercise } from '@/lib/schemas/exercise';
import { partyIdentityFor } from '@/lib/documents/party-directory';
import { COMPANY_DETAILS } from '@/lib/documents/company-details';
import {
  amountInWords,
  formatHsnSac,
  hsnSacFor,
  reverseChargeFromLegs,
  taxRatePercentOf,
} from '@/lib/documents/gst-invoice-fields';
import { documentNumberOf, partyLegOf } from '@/lib/db/queries/company';

// The old LLM-written bank statement path (generateBankStatementDocument,
// checkBankStatementContent and their prompts) was deleted on 2026-09-17:
// the statement has been built by code since 2026-09-03
// (build-bank-statement.ts) and nothing called it any more.

const MAX_ATTEMPTS = 3;

const AMOUNT_TOLERANCE = 0.01;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

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

function referenceOf(legs: ReadonlyArray<AnswerKeyEntry>): string | null {
  return legs.find((leg) => leg.bill_reference)?.bill_reference ?? null;
}

// Credit sales and credit purchases whose key carries no number of their
// own (2026-09-17). Such a voucher used to print a CM-yymmdd-seq "tax
// invoice" (sales) or a number the model invented (purchases), which the
// learner then allocated against and the key could not score. The
// generation checks call this and reject the batch; the document builders
// throw on the same condition as a backstop. A cash sale/purchase (no party
// leg) needs no number: a cash memo is numbered by code.
export type MissingBillNumber = { sequence: number; voucherType: 'Sales' | 'Purchase'; party: string };

export function missingBillNumbersInLegs(legs: ReadonlyArray<AnswerKeyEntry>): MissingBillNumber | null {
  if (legs.length === 0) return null;
  const voucherType = legs[0].voucher_type.trim().toLowerCase();
  if (voucherType !== 'sales' && voucherType !== 'purchase') return null;
  const party = partyLegOf([...legs], legs[0].voucher_type);
  if (!party) return null;
  if (documentNumberOf(referenceOf(legs))) return null;
  return {
    sequence: legs[0].sequence,
    voucherType: voucherType === 'sales' ? 'Sales' : 'Purchase',
    party: party.correct_account,
  };
}

export function missingBillNumbers(generated: GeneratedExercise): MissingBillNumber[] {
  const bySequence = new Map<number, AnswerKeyEntry[]>();
  for (const entry of generated.answer_key.entries) {
    const legs = bySequence.get(entry.sequence) ?? [];
    legs.push(entry);
    bySequence.set(entry.sequence, legs);
  }
  return [...bySequence.values()]
    .map((legs) => missingBillNumbersInLegs(legs))
    .filter((missing): missing is MissingBillNumber => missing !== null)
    .sort((a, b) => a.sequence - b.sequence);
}

// A goods purchase may print several stock lines (cotton, polyester) that all
// post to Purchases. A service or expense bill may not: Praveen posted
// MA/206's two printed lines ("Professional consultation 10,000", "Audit and
// compliance review 5,000") to two ledgers, exactly as the document invited,
// and was scored AMOUNT_WRONG + ACCOUNT_WRONG against a key with one
// 15,000 leg (2026-09-04). One expense leg, one printed line.
const GOODS_ACCOUNT_PATTERN = /\b(purchase|purchases|goods|stock|material|materials|inventory)\b/i;

const ROUND_OFF_PATTERN = /round(?:ing)?[\s-]*off/i;

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

// The printed invoice number compared honestly (2026-09-17): trimmed,
// whitespace-collapsed, case-insensitive, and nothing else. Stripping every
// punctuation mark accepted "INV-10-1" for "INV-1-01".
function sameDocumentNumber(printed: string, expected: string): boolean {
  const canonical = (value: string) => value.trim().replace(/\s+/g, ' ').toUpperCase();
  return canonical(printed) === canonical(expected);
}

// Deterministic figure/date validation for a generated invoice. Every
// delivered invoice in the first live intern batches contradicted its answer
// key (wrong totals, missing IGST, all dated "2024-01-15"); with this check a
// document-vs-answer-key contradiction is retried. Whatever passes is then
// overwritten from the key anyway (stampVendorInvoiceFromKey), so the model
// only ever contributes line wording. Exported for tests.
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

  // The printed invoice number is the bill reference the learner allocates
  // and the key scores (2026-09-11): a different number on the paper would
  // fail every settlement that quotes it.
  // Its own number, never the advance the bill adjusts (2026-09-15).
  const expectedNumber = documentNumberOf(referenceOf(input.legs));
  if (expectedNumber && !sameDocumentNumber(content.invoiceNumber, expectedNumber)) {
    violations.push(`invoiceNumber is "${content.invoiceNumber}" but must be exactly "${expectedNumber}".`);
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

type LineItem = VendorInvoiceContent['lineItems'][number];

// Quantity × rate must equal the amount the line prints; a line that does
// not multiply out becomes 1 × amount.
function consistentLine(item: LineItem): LineItem {
  const amount = round2(item.amount);
  const multiplies = item.quantity > 0 && Math.abs(item.quantity * item.rate - amount) < AMOUNT_TOLERANCE;
  return multiplies ? { ...item, amount } : { ...item, quantity: 1, rate: amount, amount };
}

// Everything the PDF prints comes from the key or from code (2026-09-17):
// vendor name (the key's party ledger), GSTIN and address (that party's one
// identity), bill number, date, every figure, and the Rule 46 particulars.
// The model's content survives only as line wording, after it passed
// checkVendorInvoiceContent. Exported for tests.
export function stampVendorInvoiceFromKey(content: VendorInvoiceContent, input: VendorInvoiceInput): VendorInvoiceContent {
  const figures = deriveInvoiceFigures(input.legs);
  const vendor = partyIdentityFor(figures.vendorAccount);
  const date = extractTransactionDate(input.transactionDescription);
  const legLines = figures.baseLines.filter((line) => !ROUND_OFF_PATTERN.test(line.account));

  let lineItems: LineItem[];
  if (legLines.length >= 2 || (legLines.length === 1 && singleLineRequired(figures))) {
    // One printed line per expense leg, the leg's own amount; the wording of
    // the model line carrying that amount is kept.
    const unclaimed = [...content.lineItems];
    lineItems = legLines.map((line) => {
      const index = unclaimed.findIndex((item) => Math.abs(item.amount - line.amount) < AMOUNT_TOLERANCE);
      const description = index === -1 ? line.account : unclaimed.splice(index, 1)[0].description;
      const amount = round2(line.amount);
      return { description, quantity: 1, rate: amount, amount, hsnSac: formatHsnSac(hsnSacFor(line.account)) };
    });
  } else {
    // One goods leg (several stock lines allowed, their sum already checked)
    // or a single-leg key: the model's lines, made to multiply out.
    const hsnSac = legLines.length === 1 ? formatHsnSac(hsnSacFor(legLines[0].account)) : undefined;
    lineItems = content.lineItems
      .filter((item) => !ROUND_OFF_PATTERN.test(item.description))
      .map((item) => ({ ...consistentLine(item), ...(hsnSac ? { hsnSac } : {}) }));
  }

  const cgst = figures.cgst === null ? null : round2(figures.cgst);
  const sgst = figures.sgst === null ? null : round2(figures.sgst);
  const igst = figures.igst === null ? null : round2(figures.igst);
  const total = round2(figures.total);
  const taxable = round2(lineItems.reduce((sum, item) => sum + item.amount, 0));
  const hasRoundOff = input.legs.some((leg) => ROUND_OFF_PATTERN.test(leg.correct_account));
  const roundOff = hasRoundOff ? round2(total - taxable - (cgst ?? 0) - (sgst ?? 0) - (igst ?? 0)) : null;

  return {
    vendorName: figures.vendorAccount,
    vendorGSTIN: vendor.gstin,
    vendorAddress: vendor.address,
    // A credit purchase always has the key's number (generateVendorInvoiceDocument
    // refuses otherwise); a cash purchase keeps the model's.
    invoiceNumber: documentNumberOf(referenceOf(input.legs)) ?? content.invoiceNumber.trim(),
    invoiceDate: date ? formatInvoiceDate(date) : content.invoiceDate,
    lineItems,
    taxBreakup: { cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst },
    totalAmount: total,
    ...(roundOff !== null ? { roundOff } : {}),
    buyerName: input.companyName ?? COMPANY_DETAILS.name,
    buyerGSTIN: COMPANY_DETAILS.gstin,
    buyerAddress: COMPANY_DETAILS.address,
    // Goods and services received at our Karnataka premises.
    placeOfSupply: COMPANY_DETAILS.state,
    placeOfSupplyCode: COMPANY_DETAILS.stateCode,
    reverseCharge: reverseChargeFromLegs(input.legs),
    taxRatePercent: taxRatePercentOf(taxable, { cgst, sgst, igst }),
    amountInWords: amountInWords(total),
  };
}

// Generates one vendor invoice, grounded on the transaction's complete leg
// set + description and validated figure-by-figure against them. Same
// bounded validate-and-retry pattern as every LLM call in this codebase.
export async function generateVendorInvoiceDocument(
  learnerId: string,
  input: VendorInvoiceInput,
): Promise<GeneratedSourceDocument> {
  const missing = missingBillNumbersInLegs(input.legs);
  if (missing) {
    throw new Error(
      `Vendor invoice for transaction ${missing.sequence}: the key gives the credit purchase from ${missing.party} no bill number of its own, and a number the model invents could never be allocated against.`,
    );
  }

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
      return { doc_type: 'vendor_invoice', content: stampVendorInvoiceFromKey(content, input) };
    }

    lastError = parsed.error.message;
  }

  throw new Error(
    `Vendor invoice generation failed validation after ${MAX_ATTEMPTS} attempts: ${lastError}`,
  );
}
