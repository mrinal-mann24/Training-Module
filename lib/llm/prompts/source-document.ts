import type { ChatMessage } from '@/lib/llm/client';
import type { AnswerKeyEntry } from '@/lib/schemas/exercise';

const VENDOR_INVOICE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_type: { type: 'string', enum: ['vendor_invoice'] },
    content: {
      type: 'object',
      additionalProperties: false,
      properties: {
        vendorName: { type: 'string' },
        vendorGSTIN: { type: 'string' },
        invoiceNumber: { type: 'string' },
        invoiceDate: { type: 'string' },
        lineItems: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              rate: { type: 'number' },
              amount: { type: 'number' },
            },
            required: ['description', 'quantity', 'rate', 'amount'],
          },
        },
        taxBreakup: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cgst_amount: { type: ['number', 'null'] },
            sgst_amount: { type: ['number', 'null'] },
            igst_amount: { type: ['number', 'null'] },
          },
          required: ['cgst_amount', 'sgst_amount', 'igst_amount'],
        },
        totalAmount: { type: 'number' },
      },
      required: ['vendorName', 'vendorGSTIN', 'invoiceNumber', 'invoiceDate', 'lineItems', 'taxBreakup', 'totalAmount'],
    },
  },
  required: ['doc_type', 'content'],
} as const;

const BANK_STATEMENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_type: { type: 'string', enum: ['bank_statement'] },
    content: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accountHolderName: { type: 'string' },
        period: { type: 'string' },
        transactions: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              date: { type: 'string' },
              narration: { type: 'string' },
              debit: { type: ['number', 'null'] },
              credit: { type: ['number', 'null'] },
              balance: { type: 'number' },
            },
            required: ['date', 'narration', 'debit', 'credit', 'balance'],
          },
        },
      },
      required: ['accountHolderName', 'period', 'transactions'],
    },
  },
  required: ['doc_type', 'content'],
} as const;

const CONTENT_BOUNDARY_INSTRUCTION = `Critical content boundary: this document must contain ONLY what a real physical
document would show — raw commercial facts and figures a vendor or bank actually
prints. NEVER state or imply the accounting classification the learner is meant to
derive. For example, an invoice may show the GST amount charged, but must never label
it "IGST Payable" or "CGST/SGST" or say which account it should be posted to — that
judgment is the entire point of the exercise. A bank statement narration should read
like a real bank's terse transaction description, never an accounting instruction.
Do not include any hint about correct ledger names, voucher types, or tax head
classification anywhere in the document.`;

// One vendor invoice, grounded on the transaction's COMPLETE leg set plus
// its description (2026-09-01): the previous single-leg grounding let the
// PDF's figures contradict the answer key — every delivered invoice in the
// first live intern batches carried a wrong total, wrong/missing tax, and an
// invented "2024-01-15" date, and since doc-backed transaction text carries
// no figures, a learner posting faithfully from the PDF was marked wrong.
export type VendorInvoiceInput = {
  // Every answer-key leg of this transaction (party + base + tax legs for
  // multi-leg keys; just the party leg for single-leg keys).
  legs: AnswerKeyEntry[];
  // The exercise's own transaction line — grounds the DATE (answer-key
  // entries carry no date field).
  transactionDescription: string;
};

// The exact figures the invoice must print, derived deterministically from
// the leg set — never left to the model. Multi-leg keys read them off the
// legs (base = the Dr non-tax legs, tax = the GST-named legs, total = the Cr
// party leg); a single-leg key carries only the party total plus gst_head/
// gst_rate, so base and tax are computed from the rate (total is inclusive).
export type VendorInvoiceFigures = {
  vendorAccount: string;
  total: number;
  base: number;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  // One entry per debited expense/asset leg (account + amount). When a bill
  // carries more than one — goods plus freight on Garima's Level 5 MS-3102,
  // 2026-09-04 — the printed line items must split the taxable value the
  // same way, or the learner who posts from the document is scored wrong.
  baseLines: { account: string; amount: number }[];
};

const GST_LEG_PATTERN = /\b(cgst|sgst|igst)\b/i;

const TDS_LEG_PATTERN = /\btds\b/i;

export function deriveInvoiceFigures(legs: AnswerKeyEntry[]): VendorInvoiceFigures {
  const taxLegs = legs.filter((leg) => GST_LEG_PATTERN.test(leg.correct_account));
  // A TDS purchase credits TWO ledgers: the vendor (net) and TDS Payable
  // (the deduction). The vendor's invoice knows nothing about our TDS — it
  // shows the gross fee — so TDS legs are neither party nor base, and the
  // printed total is the vendor's net plus the TDS withheld. Taking "the
  // first credited non-GST leg" made TDS Payable the vendor of Praveen's
  // Level 6 legal-fee invoice, total 2,000 instead of Sharma Legal 20,000
  // (2026-09-03).
  const tdsLegs = legs.filter((leg) => TDS_LEG_PATTERN.test(leg.correct_account));
  const nonTax = legs.filter((leg) => !GST_LEG_PATTERN.test(leg.correct_account) && !TDS_LEG_PATTERN.test(leg.correct_account));
  // On a purchase the vendor is the credited leg; base legs are the debits.
  const partyLeg = nonTax.find((leg) => leg.dr_cr === 'Cr') ?? nonTax[0];
  const baseLegs = nonTax.filter((leg) => leg !== partyLeg);
  const tdsWithheld = tdsLegs.filter((leg) => leg.dr_cr === 'Cr').reduce((sum, leg) => sum + leg.amount, 0);

  if (legs.length === 1) {
    // Single-leg key: party total inclusive of tax; split by the stated rate.
    const head = partyLeg.gst_head;
    if (!head) {
      return { vendorAccount: partyLeg.correct_account, total: partyLeg.amount, base: partyLeg.amount, cgst: null, sgst: null, igst: null, baseLines: [] };
    }
    // For CGST/SGST the key stores the PER-HEAD rate (gst_rate 9 = 9% CGST +
    // 9% SGST = 18% combined — confirmed against Praveen's live key,
    // 2026-09-01); IGST's rate is already the whole tax.
    const statedRate = partyLeg.gst_rate ?? (head === 'IGST' ? 18 : 9);
    const combinedRate = (head === 'IGST' ? statedRate : statedRate * 2) / 100;
    const base = Math.round(partyLeg.amount / (1 + combinedRate));
    const tax = partyLeg.amount - base;
    return head === 'IGST'
      ? { vendorAccount: partyLeg.correct_account, total: partyLeg.amount, base, cgst: null, sgst: null, igst: tax, baseLines: [] }
      : { vendorAccount: partyLeg.correct_account, total: partyLeg.amount, base, cgst: tax / 2, sgst: tax / 2, igst: null, baseLines: [] };
  }

  const headAmount = (head: string) => {
    const matched = taxLegs.filter((leg) => new RegExp(`\\b${head}\\b`, 'i').test(leg.correct_account));
    return matched.length > 0 ? matched.reduce((sum, leg) => sum + leg.amount, 0) : null;
  };
  return {
    vendorAccount: partyLeg.correct_account,
    total: partyLeg.amount + tdsWithheld,
    base: baseLegs.reduce((sum, leg) => sum + leg.amount, 0),
    cgst: headAmount('cgst'),
    sgst: headAmount('sgst'),
    igst: headAmount('igst'),
    baseLines: baseLegs.map((leg) => ({ account: leg.correct_account, amount: leg.amount })),
  };
}

// Pulls the transaction's date out of its description line ("On 06-May-2026,
// ..." / "06/05/2026") — the same token shapes checkBatchMonth validates.
export function extractTransactionDate(
  description: string,
): { day: number; monthIndex: number; year: number } | null {
  const MONTH_ABBREVS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const named = /\b(\d{1,2})[-\s/]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-\s/]*(\d{4})\b/i.exec(description);
  if (named) {
    return { day: Number(named[1]), monthIndex: MONTH_ABBREVS.indexOf(named[2].toLowerCase()), year: Number(named[3]) };
  }
  const numeric = /\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/.exec(description);
  if (numeric) {
    return { day: Number(numeric[1]), monthIndex: Number(numeric[2]) - 1, year: Number(numeric[3]) };
  }
  return null;
}

const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatInvoiceDate(date: { day: number; monthIndex: number; year: number }): string {
  return `${String(date.day).padStart(2, '0')}-${MONTH_NAMES_SHORT[date.monthIndex]}-${date.year}`;
}

// With one expense leg the model may split the taxable value freely; with
// several (goods + freight, fee + reimbursement) each printed line must carry
// one leg's exact amount so the document and the key tell the same story.
function lineItemRequirement(figures: VendorInvoiceFigures): string {
  if (figures.baseLines.length < 2) {
    return `- lineItems: one or more items whose amounts SUM to exactly ${figures.base}
  (taxable value, before tax).`;
  }
  const lines = figures.baseLines
    .map((line) => `    - one line for "${line.account}" with amount exactly ${line.amount}`)
    .join('\n');
  return `- lineItems: exactly ${figures.baseLines.length} items, one per component below, each
  with the stated amount (describe it naturally, e.g. freight for a freight leg):
${lines}
  (they sum to the taxable value ${figures.base}).`;
}

function buildVendorInvoiceSystemPrompt(input: VendorInvoiceInput): string {
  const figures = deriveInvoiceFigures(input.legs);
  const date = extractTransactionDate(input.transactionDescription);
  const billRef = input.legs.find((leg) => leg.bill_reference)?.bill_reference;

  const taxLines = [
    figures.cgst !== null ? `  cgst_amount: exactly ${figures.cgst}` : '  cgst_amount: null',
    figures.sgst !== null ? `  sgst_amount: exactly ${figures.sgst}` : '  sgst_amount: null',
    figures.igst !== null ? `  igst_amount: exactly ${figures.igst}` : '  igst_amount: null',
  ].join('\n');

  return `You are generating structured source-document content for an accounting training
exercise: a realistic vendor invoice/bill, the kind a small Indian trading
business would receive from a supplier. Include the vendor's name, a
valid-looking GSTIN format, an invoice number, the invoice date, one or more
line items, the tax breakup as printed, and the total.

HARD FIGURE REQUIREMENTS — these are the exact numbers the answer key scores
against, and the learner's ONLY source for them is this document, so they are
non-negotiable:
- vendorName: "${figures.vendorAccount}" exactly (never an invented name).
- invoiceDate: exactly "${date ? formatInvoiceDate(date) : 'the date stated in the transaction description below'}".
- invoiceNumber: ${billRef ? `"${String(billRef).split(/[\s(]/)[0]}" exactly` : 'a realistic bill number'}.
${lineItemRequirement(figures)}
- taxBreakup:
${taxLines}
- totalAmount: exactly ${figures.total} (line items plus tax).

Transaction being documented: ${input.transactionDescription}

${CONTENT_BOUNDARY_INSTRUCTION}

Never use an em dash anywhere in the text you produce; use a colon, comma, or full stop.

Respond only with JSON matching the provided schema.`;
}

export function buildVendorInvoicePrompt(
  input: VendorInvoiceInput,
): { messages: ChatMessage[]; jsonSchema: { name: string; schema: Record<string, unknown> } } {
  return {
    messages: [
      { role: 'system', content: buildVendorInvoiceSystemPrompt(input) },
      { role: 'user', content: `Generate the vendor invoice for transaction ${input.legs[0].sequence}.` },
    ],
    jsonSchema: {
      name: 'vendor_invoice',
      schema: VENDOR_INVOICE_JSON_SCHEMA,
    },
  };
}

export function buildVendorInvoiceRetryPrompt(
  input: VendorInvoiceInput,
  validationError: string,
): { messages: ChatMessage[]; jsonSchema: { name: string; schema: Record<string, unknown> } } {
  const base = buildVendorInvoicePrompt(input);
  return {
    ...base,
    messages: [
      ...base.messages,
      {
        role: 'user',
        content: `Your previous response failed validation with this error: ${validationError}. Respond again with corrected JSON matching the schema and the HARD FIGURE REQUIREMENTS exactly.`,
      },
    ],
  };
}

// One transaction to appear as a line on the combined bank statement:
// the answer-key entry grounds the amount/direction, the exercise's own
// transaction description grounds the DATE and business context (answer-key
// entries carry no date field).
export type BankStatementLineInput = {
  entry: AnswerKeyEntry;
  partyAccounts: string[];
  transactionDescription: string;
};

// A real bank statement is ONE document listing every movement in the period,
// not one PDF per transaction (live intern feedback, 2026-09-01: a batch
// delivered three separate "Bank Statement" cards). This prompt generates a
// single statement whose transactions array carries one line per flagged
// bank transaction in the batch.
function buildBankStatementBatchSystemPrompt(lines: BankStatementLineInput[], companyName: string): string {
  const transactionBlocks = lines
    .map(
      (line, index) => `Transaction ${index + 1} (exercise item ${line.entry.sequence}):
- Exercise description: ${line.transactionDescription}
- Parties/accounts involved: ${line.partyAccounts.join('; ') || '(none listed)'}
- Amount: ${line.entry.amount}
- Voucher type: ${line.entry.voucher_type}
- Bill reference: ${line.entry.bill_reference ?? 'none'}`,
    )
    .join('\n\n');

  return `You are generating structured source-document content for an accounting training
exercise: ONE realistic bank statement excerpt for a small Indian trading
business, covering ALL of the transactions listed below as separate statement
lines.

Hard requirements:
- Exactly one statement line per transaction below — ${lines.length} line(s) total,
  in chronological date order, dated per each transaction's own description.
- Each line: the date, a terse real-bank-style narration (transfer mode plus a
  reference number plus the counterparty, e.g. "NEFT/N26050101/SIGNAGE/PMT"),
  either debit or credit set (the other null) matching the money direction from
  the business's point of view, and a running balance that is arithmetically
  consistent from line to line (start from a plausible opening balance).
- The account holder is EXACTLY "${companyName}" — never an invented company
  name; the period covers the span of the listed dates.
- Line amounts must equal each transaction's stated amount exactly.
- When a transaction lists a bill reference, that reference MUST appear
  verbatim inside that line's narration (e.g. "NEFT/N26050114/KARNATAKA
  EMPORIUM/INV KE-305"): the learner allocates the receipt or payment against
  the bill number they read on the statement, and can never know a number the
  statement does not show.

${transactionBlocks}

${CONTENT_BOUNDARY_INSTRUCTION}

Never use an em dash anywhere in the text you produce; use a colon, comma, or full stop.

Respond only with JSON matching the provided schema.`;
}

export function buildBankStatementBatchPrompt(lines: BankStatementLineInput[], companyName: string): {
  messages: ChatMessage[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
} {
  return {
    messages: [
      { role: 'system', content: buildBankStatementBatchSystemPrompt(lines, companyName) },
      {
        role: 'user',
        content: `Generate the single combined bank statement covering exercise items ${lines
          .map((line) => line.entry.sequence)
          .join(', ')}.`,
      },
    ],
    jsonSchema: {
      name: 'bank_statement',
      schema: BANK_STATEMENT_JSON_SCHEMA,
    },
  };
}

export function buildBankStatementBatchRetryPrompt(
  lines: BankStatementLineInput[],
  companyName: string,
  validationError: string,
): { messages: ChatMessage[]; jsonSchema: { name: string; schema: Record<string, unknown> } } {
  const base = buildBankStatementBatchPrompt(lines, companyName);
  return {
    ...base,
    messages: [
      ...base.messages,
      {
        role: 'user',
        content: `Your previous response failed schema validation with this error: ${validationError}. Respond again with corrected JSON matching the schema exactly.`,
      },
    ],
  };
}

