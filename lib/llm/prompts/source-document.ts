import type { ChatMessage } from '@/lib/llm/client';
import type { AnswerKeyEntry } from '@/lib/schemas/exercise';
import type { SourceDocumentType } from '@/lib/schemas/source-document';

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

// Grounds the document's figures in the specific answer-key entry it
// represents, so a learner correctly working from the document arrives at
// exactly the posting the answer key expects — the document's total/amount
// must be internally consistent with entry.amount.
function buildTransactionContext(entry: AnswerKeyEntry, partyAccounts: string[]): string {
  const partyLine =
    partyAccounts.length > 0
      ? `- Parties/accounts involved in this transaction: ${partyAccounts.join('; ')}
  The document's vendor/customer/account-holder name MUST be the counterparty
  from this list — NEVER an invented name (a document naming a party that
  appears nowhere in the exercise confuses the learner and is wrong).`
      : '';
  return `The document represents this transaction from the exercise's answer key
(grounding only — never reproduce this raw structure in the document itself):
${partyLine}
- Amount: ${entry.amount}
- Voucher type: ${entry.voucher_type}
- GST head: ${entry.gst_head ?? 'none'}, rate: ${entry.gst_rate ?? 'n/a'}
- TDS section: ${entry.tds_section ?? 'none'}, rate: ${entry.tds_rate ?? 'n/a'}, base: ${entry.tds_base ?? 'n/a'}
- Bill reference: ${entry.bill_reference ?? 'none'}

The document's figures (line item amounts, tax breakup, total, or transaction
amount/balance) must be internally consistent with this amount and tax
information — a learner correctly reading the document and applying their own
accounting judgment should arrive at a posting matching this answer key entry.`;
}

function buildSystemPrompt(docType: SourceDocumentType, entry: AnswerKeyEntry, partyAccounts: string[]): string {
  const docTypeInstruction =
    docType === 'vendor_invoice'
      ? `Generate the structured content for a realistic vendor invoice/bill — the kind a
small Indian trading business would receive from a supplier. Include the vendor's
name (from the transaction context below), a valid-looking GSTIN format, an invoice number, an invoice date, one or
more line items, the tax breakup as it would actually be printed (CGST+SGST for an
intra-state supply, or IGST for inter-state — pick whichever is consistent with the
transaction context below, and leave the unused fields null), and the total amount.`
      : `Generate the structured content for a realistic bank statement excerpt covering the
period this transaction falls in. Include a plausible account holder name, the
statement period, and a list of transactions (one of which is the transaction
described below) with date, a terse bank-style narration, debit/credit amounts (only
one of the two set per row, the other null), and a running balance.`;

  return `You are generating structured source-document content for an accounting training
exercise. ${docTypeInstruction}

${buildTransactionContext(entry, partyAccounts)}

${CONTENT_BOUNDARY_INSTRUCTION}

Never use an em dash anywhere in the text you produce; use a colon, comma, or full stop.

Respond only with JSON matching the provided schema.`;
}

export function buildSourceDocumentPrompt(
  docType: SourceDocumentType,
  entry: AnswerKeyEntry,
  partyAccounts: string[],
): { messages: ChatMessage[]; jsonSchema: { name: string; schema: Record<string, unknown> } } {
  return {
    messages: [
      { role: 'system', content: buildSystemPrompt(docType, entry, partyAccounts) },
      { role: 'user', content: `Generate the ${docType} content for transaction ${entry.sequence}.` },
    ],
    jsonSchema: {
      name: docType,
      schema: docType === 'vendor_invoice' ? VENDOR_INVOICE_JSON_SCHEMA : BANK_STATEMENT_JSON_SCHEMA,
    },
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

export function buildSourceDocumentRetryPrompt(
  docType: SourceDocumentType,
  entry: AnswerKeyEntry,
  partyAccounts: string[],
  validationError: string,
): { messages: ChatMessage[]; jsonSchema: { name: string; schema: Record<string, unknown> } } {
  const base = buildSourceDocumentPrompt(docType, entry, partyAccounts);
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
