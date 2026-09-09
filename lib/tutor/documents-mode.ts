import type { GeneratedExercise } from '@/lib/schemas/exercise';
import type { MonthEndNotesContent, SalesInvoiceContent, SourceDocumentType } from '@/lib/schemas/source-document';
import { isBankLedger, partyLegOf, splitBillReferences } from '@/lib/db/queries/company';
import { extractTransactionDate, formatInvoiceDate } from '@/lib/llm/prompts/source-document';
import { COMPANY_DETAILS } from '@/lib/documents/company-details';

// Documents mode (2026-09-09). Once a learner has mastered enough concepts,
// a batch stops spelling entries out in text: every transaction is
// delivered as the paperwork a real month produces. Purchases keep their
// vendor invoice, bank movements keep the one bank statement, sales get our
// own invoice (or a cash memo), and everything that has no third-party
// document in real life — accruals, prepaid write-offs, GST set-off,
// suspense clearing, returns — goes onto one month-end notes sheet. The
// brief then only says what arrived and when.
//
// Everything here is deterministic and reads the answer key: the model's
// per-transaction document choices are overridden, the pointer lines are
// written by code, and the sales invoice figures come straight from the
// legs — so the documents can never disagree with the key.

export const DOCUMENTS_MODE_MASTERY_THRESHOLD = 3;

export function isDocumentsModeUnlocked(mastery: Iterable<{ status: string }>): boolean {
  let mastered = 0;
  for (const row of mastery) {
    if (row.status === 'mastered') mastered += 1;
  }
  return mastered >= DOCUMENTS_MODE_MASTERY_THRESHOLD;
}

// The one-time AI Accountant setup flow (app/(chat)/chat/AiaOnboarding.tsx)
// is due as soon as documents mode is unlocked, after the first-day
// walkthrough, until the learner has completed it. Evaluated server-side on
// every chat load, so it also catches learners who crossed the threshold
// before the feature shipped.
export function isAiaOnboardingDue(params: {
  walkthroughCompleted: boolean;
  aiaOnboardingCompletedAt: string | null;
  mastery: Iterable<{ status: string }>;
}): boolean {
  return params.walkthroughCompleted && params.aiaOnboardingCompletedAt === null && isDocumentsModeUnlocked(params.mastery);
}

type Entry = GeneratedExercise['answer_key']['entries'][number];

export type DocumentsModePlan = {
  generated: GeneratedExercise;
  salesInvoices: { sequence: number; content: SalesInvoiceContent }[];
  monthEndNotes: MonthEndNotesContent | null;
};

const GST_LEG_PATTERN = /\b(cgst|sgst|igst)\b/i;
const TDS_LEG_PATTERN = /\btds\b/i;
const CASH_LEDGER_PATTERN = /^cash\b|cash-in-hand/i;
const AMOUNT_TOLERANCE = 0.01;

export function documentTypeForVoucher(voucherType: string): SourceDocumentType {
  const type = voucherType.trim().toLowerCase();
  if (type === 'purchase') return 'vendor_invoice';
  if (type === 'sales') return 'sales_invoice';
  if (type === 'contra' || type === 'receipt' || type === 'payment') return 'bank_statement';
  return 'month_end_note';
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function firstBillReference(legs: Entry[]): string | null {
  const reference = legs.find((leg) => leg.bill_reference)?.bill_reference;
  return reference ? (splitBillReferences(reference)[0] ?? null) : null;
}

function counterpartyOf(legs: Entry[], voucherType: string): string | null {
  const party = partyLegOf(legs, voucherType);
  if (party) return party.correct_account;
  // An expense payment (bank charges, a TDS remittance) has no party: name
  // the ledger the money was for.
  const other = legs.find((leg) => !isBankLedger(leg.correct_account) && !CASH_LEDGER_PATTERN.test(leg.correct_account));
  return other?.correct_account ?? null;
}

function lineDescriptionFor(account: string): string {
  if (/freight|delivery|transport/i.test(account)) return 'Freight and delivery charges';
  if (/^sales\b|goods|trading/i.test(account)) return 'Trading goods as per order';
  return account;
}

// Our outgoing invoice for one Sales transaction, read off the legs: the
// customer (or Cash) is the debited party, the credited non-tax legs are
// the taxable lines, the credited GST legs are the tax. Throws when the
// legs do not add up — a wrong document must never be delivered.
export function buildSalesInvoiceContent(
  legs: Entry[],
  description: string,
  companyName: string,
): SalesInvoiceContent {
  const sequence = legs[0].sequence;
  const date = extractTransactionDate(description);
  if (!date) throw new Error(`Sales invoice for transaction ${sequence}: no date in "${description}".`);

  const taxLegs = legs.filter((leg) => GST_LEG_PATTERN.test(leg.correct_account));
  const tdsLegs = legs.filter((leg) => TDS_LEG_PATTERN.test(leg.correct_account));
  const nonTax = legs.filter((leg) => !GST_LEG_PATTERN.test(leg.correct_account) && !TDS_LEG_PATTERN.test(leg.correct_account));
  const party = nonTax.find((leg) => leg.dr_cr === 'Dr');
  const baseLegs = nonTax.filter((leg) => leg.dr_cr === 'Cr');
  if (!party || baseLegs.length === 0) {
    throw new Error(`Sales invoice for transaction ${sequence}: legs do not form a sale (${legs.map((l) => `${l.dr_cr} ${l.correct_account}`).join(', ')}).`);
  }

  const headAmount = (head: string): number | null => {
    const matched = taxLegs.filter((leg) => leg.dr_cr === 'Cr' && new RegExp(`\\b${head}\\b`, 'i').test(leg.correct_account));
    return matched.length > 0 ? round2(matched.reduce((sum, leg) => sum + leg.amount, 0)) : null;
  };
  const cgst = headAmount('cgst');
  const sgst = headAmount('sgst');
  const igst = headAmount('igst');
  const base = round2(baseLegs.reduce((sum, leg) => sum + leg.amount, 0));
  const tdsWithheld = round2(tdsLegs.filter((leg) => leg.dr_cr === 'Dr').reduce((sum, leg) => sum + leg.amount, 0));
  const total = round2(party.amount + tdsWithheld);
  const computed = round2(base + (cgst ?? 0) + (sgst ?? 0) + (igst ?? 0));
  if (Math.abs(computed - total) > AMOUNT_TOLERANCE) {
    throw new Error(`Sales invoice for transaction ${sequence}: lines ${computed} do not add up to the party total ${total}.`);
  }

  const isCashMemo = CASH_LEDGER_PATTERN.test(party.correct_account);
  const stamp = `${String(date.year).slice(-2)}${String(date.monthIndex + 1).padStart(2, '0')}${String(date.day).padStart(2, '0')}`;
  return {
    sellerName: companyName,
    sellerGSTIN: COMPANY_DETAILS.gstin,
    sellerAddress: COMPANY_DETAILS.address,
    buyerName: isCashMemo ? 'Cash (walk-in customer)' : party.correct_account,
    placeOfSupply: igst !== null ? 'Inter-state (IGST)' : COMPANY_DETAILS.state,
    invoiceNumber: firstBillReference(legs) ?? `CM-${stamp}-${String(sequence).padStart(2, '0')}`,
    invoiceDate: formatInvoiceDate(date),
    isCashMemo,
    lineItems: baseLegs.map((leg) => ({
      description: lineDescriptionFor(leg.correct_account),
      quantity: 1,
      rate: round2(leg.amount),
      amount: round2(leg.amount),
    })),
    taxBreakup: { cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst },
    totalAmount: total,
  };
}

// The learner-facing line for a document-backed transaction: date, party,
// what happened, where to look. Never an amount, a rate or a tax split.
function pointerFor(docType: SourceDocumentType, legs: Entry[], dateLabel: string, noteNumber: number | null): string {
  const voucherType = legs[0].voucher_type;
  const party = counterpartyOf(legs, voucherType);
  const reference = firstBillReference(legs);
  switch (docType) {
    case 'vendor_invoice':
      return `On ${dateLabel}, an invoice arrived from ${party ?? 'a vendor'}${reference ? ` (Ref ${reference})` : ''}: post it from the attached invoice.`;
    case 'sales_invoice': {
      // The debited non-tax leg is the buyer; partyLegOf excludes Cash by
      // design, so look at the leg directly to spot a counter sale.
      const buyerLeg = legs.find((leg) => leg.dr_cr === 'Dr' && !GST_LEG_PATTERN.test(leg.correct_account) && !TDS_LEG_PATTERN.test(leg.correct_account));
      if (buyerLeg && CASH_LEDGER_PATTERN.test(buyerLeg.correct_account)) {
        return `On ${dateLabel}, a counter sale was made for cash: post it from the attached cash memo.`;
      }
      return `On ${dateLabel}, you raised Sales Invoice ${reference ?? ''} on ${party ?? 'a customer'}: post it from the attached sales invoice.`.replace('  ', ' ');
    }
    case 'bank_statement': {
      const type = voucherType.trim().toLowerCase();
      const bankLeg = legs.find((leg) => isBankLedger(leg.correct_account));
      const inflow = bankLeg?.dr_cr === 'Dr';
      if (type === 'contra') {
        return inflow
          ? `On ${dateLabel}, cash was deposited into the bank: post it from the bank statement.`
          : `On ${dateLabel}, cash was withdrawn from the bank: post it from the bank statement.`;
      }
      const against = reference ? ` against bill ${reference}` : '';
      return inflow
        ? `On ${dateLabel}, a receipt from ${party ?? 'a party'}${against} landed in the bank: post it from the bank statement.`
        : `On ${dateLabel}, a payment to ${party ?? 'a party'}${against} went out from the bank: post it from the bank statement.`;
    }
    case 'month_end_note':
      return `On ${dateLabel}, post month-end note ${noteNumber} from the attached Month-end Notes document.`;
  }
}

// Retry-loop check for documents mode: a transaction that will land on the
// month-end notes sheet must still carry its figures in the text, because
// that text IS the note. If the model wrote a figure-less pointer for a
// journal (it sometimes over-applies the pointer rule), the batch is
// retried rather than delivered with an unusable note.
const RUPEE_FIGURE_PATTERN = /(?:₹|\bRs\.?\s?)\s*[\d,]+/i;

export function checkMonthEndNoteDetails(generated: GeneratedExercise): string | null {
  const voucherTypeBySequence = new Map<number, string>();
  for (const entry of generated.answer_key.entries) {
    if (!voucherTypeBySequence.has(entry.sequence)) voucherTypeBySequence.set(entry.sequence, entry.voucher_type);
  }
  const offenders = generated.transactions
    .filter((transaction) => {
      const voucherType = voucherTypeBySequence.get(transaction.sequence);
      return voucherType !== undefined
        && documentTypeForVoucher(voucherType) === 'month_end_note'
        && !RUPEE_FIGURE_PATTERN.test(transaction.description);
    })
    .map((transaction) => transaction.sequence);
  if (offenders.length === 0) return null;
  return `Documents mode: transaction${offenders.length === 1 ? '' : 's'} ${offenders.join(', ')} ${offenders.length === 1 ? 'is a journal-type entry (journal, debit note or credit note) whose text states' : 'are journal-type entries (journal, debit note or credit note) whose text states'} no amount. Those entries are delivered as a month-end notes sheet built from the text itself, so write them with full explicit details (date, ledgers involved, every amount) and requires_source_document false.`;
}

export function applyDocumentsMode(
  generated: GeneratedExercise,
  params: { companyName: string; monthLabel: string },
): DocumentsModePlan {
  const legsBySequence = new Map<number, Entry[]>();
  for (const entry of generated.answer_key.entries) {
    const legs = legsBySequence.get(entry.sequence) ?? [];
    legs.push(entry);
    legsBySequence.set(entry.sequence, legs);
  }

  const docTypeBySequence = new Map<number, SourceDocumentType>();
  const noteNumberBySequence = new Map<number, number>();
  const notes: MonthEndNotesContent['notes'] = [];
  const salesInvoices: DocumentsModePlan['salesInvoices'] = [];

  const transactions = generated.transactions.map((transaction) => {
    const legs = legsBySequence.get(transaction.sequence);
    if (!legs || legs.length === 0) return transaction;
    const docType = documentTypeForVoucher(legs[0].voucher_type);
    docTypeBySequence.set(transaction.sequence, docType);
    const date = extractTransactionDate(transaction.description);
    const dateLabel = date ? formatInvoiceDate(date) : transaction.description.split(',')[0].replace(/^On\s+/i, '');

    let noteNumber: number | null = null;
    if (docType === 'month_end_note') {
      noteNumber = notes.length + 1;
      noteNumberBySequence.set(transaction.sequence, noteNumber);
      notes.push({ number: noteNumber, date: dateLabel, text: transaction.description });
    }
    if (docType === 'sales_invoice') {
      salesInvoices.push({ sequence: transaction.sequence, content: buildSalesInvoiceContent(legs, transaction.description, params.companyName) });
    }
    return { ...transaction, description: pointerFor(docType, legs, dateLabel, noteNumber) };
  });

  const entries = generated.answer_key.entries.map((entry) => {
    const docType = docTypeBySequence.get(entry.sequence);
    return docType ? { ...entry, requires_source_document: true, source_document_type: docType } : entry;
  });

  const counts = { invoices: 0, sales: 0, bank: 0 };
  for (const docType of docTypeBySequence.values()) {
    if (docType === 'vendor_invoice') counts.invoices += 1;
    else if (docType === 'sales_invoice') counts.sales += 1;
    else if (docType === 'bank_statement') counts.bank += 1;
  }
  const parts = [
    counts.invoices > 0 ? `${counts.invoices} vendor invoice${counts.invoices === 1 ? '' : 's'}` : null,
    counts.sales > 0 ? `${counts.sales} sales invoice${counts.sales === 1 ? '' : 's'} or cash memo${counts.sales === 1 ? '' : 's'}` : null,
    counts.bank > 0 ? 'one bank statement' : null,
    notes.length > 0 ? 'one month-end notes sheet' : null,
  ].filter((part): part is string => part !== null);
  const coverNote = `Documents mode: this month arrives as paperwork, ${parts.join(', ')}. Every entry is posted from the attached documents; the list below only says what arrived and when.`;

  return {
    generated: {
      ...generated,
      scenario: `${generated.scenario}\n\n${coverNote}`,
      transactions,
      answer_key: { ...generated.answer_key, entries },
    },
    salesInvoices,
    monthEndNotes:
      notes.length > 0 ? { companyName: params.companyName, period: params.monthLabel, notes } : null,
  };
}
