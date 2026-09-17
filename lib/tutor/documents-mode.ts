import { isRetiredConcept, type AnswerKey, type GeneratedExercise } from '@/lib/schemas/exercise';
import type { MonthEndNotesContent, SalesInvoiceContent, SalesRegisterContent, SourceDocumentType } from '@/lib/schemas/source-document';
import {
  documentNumberOf,
  isBankLedger,
  normalizeBillReference,
  parseBillReferences,
  partyLegOf,
} from '@/lib/db/queries/company';
import { extractTransactionDate, formatInvoiceDate } from '@/lib/llm/prompts/source-document';
import { COMPANY_DETAILS } from '@/lib/documents/company-details';
import { buildSalesRegisterContent } from '@/lib/documents/build-sales-register';
import { partyIdentityFor } from '@/lib/documents/party-directory';
import { amountInWords, formatHsnSac, hsnSacFor, reverseChargeFromLegs, taxRatePercentOf } from '@/lib/documents/gst-invoice-fields';

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

// Two mastered concepts (2026-09-10, was three): from then on every batch is
// documents only — no transaction text at all — and the AI Accountant setup
// popup is due. Retired concepts never count.
export const DOCUMENTS_MODE_MASTERY_THRESHOLD = 2;

export function isDocumentsModeUnlocked(mastery: Iterable<{ status: string; concept_tag?: string }>): boolean {
  let mastered = 0;
  for (const row of mastery) {
    if (row.status === 'mastered' && !(row.concept_tag && isRetiredConcept(row.concept_tag))) mastered += 1;
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
  // CSV of the month's sales for AI Accountant (its sales screen takes no
  // PDFs); null when the batch has no sale. Same figures as salesInvoices.
  salesRegister: SalesRegisterContent | null;
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

function referenceOf(legs: Entry[]): string | null {
  return legs.find((leg) => leg.bill_reference)?.bill_reference ?? null;
}

// Parties and references of customer advances that carried GST (Output GST
// on Advance): advances for SERVICES (rulebook 9B; a goods advance carries
// none, 9A). The invoice that adjusts one supplies a service, not goods.
export function serviceAdvanceReferences(keys: ReadonlyArray<{ entries?: Entry[] }>): Set<string> {
  const ids = new Set<string>();
  for (const key of keys) {
    const bySequence = new Map<number, Entry[]>();
    for (const entry of key.entries ?? []) {
      const legs = bySequence.get(entry.sequence) ?? [];
      legs.push(entry);
      bySequence.set(entry.sequence, legs);
    }
    for (const legs of bySequence.values()) {
      if (!/^receipt$/i.test(legs[0].voucher_type.trim())) continue;
      if (!legs.some((leg) => GST_LEG_PATTERN.test(leg.correct_account) && /\bon\s+advance\b/i.test(leg.correct_account))) continue;
      const party = partyLegOf(legs, 'Receipt');
      if (!party) continue;
      for (const parsed of parseBillReferences(referenceOf(legs))) {
        ids.add(`${party.correct_account}|${normalizeBillReference(parsed.ref)}`);
      }
    }
  }
  return ids;
}

// Pre-flight for the retry loop (2026-09-11): buildSalesInvoiceContent
// throws on a sale whose legs it cannot print (no date, no customer leg,
// a discount or round-off leg the lines do not add up with), and until now
// that throw came after every validation had passed, killing the job
// instead of asking the model for another attempt.
export function checkSalesInvoicesBuildable(generated: GeneratedExercise, companyName: string): string | null {
  const legsBySequence = new Map<number, Entry[]>();
  for (const entry of generated.answer_key.entries) {
    const legs = legsBySequence.get(entry.sequence) ?? [];
    legs.push(entry);
    legsBySequence.set(entry.sequence, legs);
  }
  const problems: string[] = [];
  for (const transaction of generated.transactions) {
    const legs = legsBySequence.get(transaction.sequence);
    if (!legs || legs.length === 0 || documentTypeForVoucher(legs[0].voucher_type) !== 'sales_invoice') continue;
    try {
      buildSalesInvoiceContent(legs, transaction.description, companyName);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (problems.length === 0) return null;
  return `Sales invoices cannot be printed from the key: ${problems.join(' ')} Give every sale a date, one debited customer (or Cash) leg, credited sales lines and GST legs that add up to the customer total; put a discount or round-off inside the line amounts; give every credit sale its own invoice number in bill_reference.`;
}

function counterpartyOf(legs: Entry[], voucherType: string): string | null {
  const party = partyLegOf(legs, voucherType);
  if (party) return party.correct_account;
  // An expense payment (bank charges, a TDS remittance) has no party: name
  // the ledger the money was for.
  const other = legs.find((leg) => !isBankLedger(leg.correct_account) && !CASH_LEDGER_PATTERN.test(leg.correct_account));
  return other?.correct_account ?? null;
}

function lineDescriptionFor(account: string, serviceSupply: boolean): string {
  if (/freight|delivery|transport/i.test(account)) return 'Freight and delivery charges';
  if (/^sales\b|goods|trading/i.test(account)) return serviceSupply ? 'Services as per agreement' : 'Trading goods as per order';
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
  options: { serviceSupply?: boolean } = {},
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
  // The invoice's own number, never the advance it adjusts (Praveen's June:
  // "ADV-C01 (Advance), INV-3001" printed as ADV-C01).
  // Only a true cash sale is numbered by code (2026-09-17): a credit sale
  // with no number used to print as a Tax Invoice "CM-yymmdd-seq", a number
  // the learner then allocated the receipt against and the key never knew.
  const ownNumber = documentNumberOf(referenceOf(legs));
  if (!isCashMemo && !ownNumber) {
    throw new Error(`Sales invoice for transaction ${sequence}: the credit sale to ${party.correct_account} has no invoice number of its own in the key.`);
  }
  // Buyer block from the customer's one identity (2026-09-17): the same
  // GSTIN, state and address in every month, whatever GST the sale charges
  // (the generation checks keep the tax head consistent with the state). A
  // walk-in cash sale has no buyer details and is supplied in our own state.
  const buyer = isCashMemo ? null : partyIdentityFor(party.correct_account);
  const lineItems = baseLegs.map((leg) => ({
    description: lineDescriptionFor(leg.correct_account, options.serviceSupply === true),
    quantity: 1,
    rate: round2(leg.amount),
    amount: round2(leg.amount),
    ...optionalHsnSac(leg.correct_account, options.serviceSupply === true),
  }));
  return {
    sellerName: companyName,
    sellerGSTIN: COMPANY_DETAILS.gstin,
    sellerAddress: COMPANY_DETAILS.address,
    buyerName: isCashMemo ? 'Cash (walk-in customer)' : party.correct_account,
    buyerAddress: buyer?.address,
    buyerGSTIN: buyer?.gstin ?? null,
    placeOfSupply: buyer?.state ?? COMPANY_DETAILS.state,
    placeOfSupplyCode: buyer?.stateCode ?? COMPANY_DETAILS.stateCode,
    invoiceNumber: ownNumber ?? `CM-${stamp}-${String(sequence).padStart(2, '0')}`,
    invoiceDate: formatInvoiceDate(date),
    isCashMemo,
    lineItems,
    taxBreakup: { cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst },
    totalAmount: total,
    // Rule 46 particulars (2026-09-17).
    reverseCharge: reverseChargeFromLegs(legs),
    taxRatePercent: taxRatePercentOf(base, { cgst, sgst, igst }),
    amountInWords: amountInWords(total),
  };
}

function optionalHsnSac(account: string, serviceSupply: boolean): { hsnSac?: string } {
  const code = formatHsnSac(hsnSacFor(account, { serviceSupply }));
  return code ? { hsnSac: code } : {};
}

// The learner-facing line for a document-backed transaction: date, party,
// what happened, where to look. Never an amount, a rate or a tax split.
function pointerFor(docType: SourceDocumentType, legs: Entry[], dateLabel: string, noteNumber: number | null): string {
  const voucherType = legs[0].voucher_type;
  const party = counterpartyOf(legs, voucherType);
  // A document is named by its own number; a bank line by every reference
  // it carries, and only settlements of existing bills read "against bill".
  const documentNumber = documentNumberOf(referenceOf(legs));
  const parsedRefs = parseBillReferences(referenceOf(legs)).filter((parsed) => parsed.kind !== 'on_account');
  switch (docType) {
    case 'vendor_invoice':
      return `On ${dateLabel}, an invoice arrived from ${party ?? 'a vendor'}${documentNumber ? ` (Ref ${documentNumber})` : ''}: post it from the attached invoice.`;
    case 'sales_invoice': {
      // The debited non-tax leg is the buyer; partyLegOf excludes Cash by
      // design, so look at the leg directly to spot a counter sale.
      const buyerLeg = legs.find((leg) => leg.dr_cr === 'Dr' && !GST_LEG_PATTERN.test(leg.correct_account) && !TDS_LEG_PATTERN.test(leg.correct_account));
      if (buyerLeg && CASH_LEDGER_PATTERN.test(buyerLeg.correct_account)) {
        return `On ${dateLabel}, a counter sale was made for cash: post it from the attached cash memo.`;
      }
      return `On ${dateLabel}, you raised Sales Invoice ${documentNumber ?? ''} on ${party ?? 'a customer'}: post it from the attached sales invoice.`.replace('  ', ' ');
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
      const listed = parsedRefs.map((parsed) => parsed.ref).join(', ');
      const against =
        parsedRefs.length === 0
          ? ''
          : parsedRefs.every((parsed) => parsed.kind === 'bill' || parsed.kind === 'against')
            ? ` against bill ${listed}`
            : ` (Ref ${listed})`;
      return inflow
        ? `On ${dateLabel}, a receipt from ${party ?? 'a party'}${against} landed in the bank: post it from the bank statement.`
        : `On ${dateLabel}, a payment to ${party ?? 'a party'}${against} went out from the bank: post it from the bank statement.`;
    }
    case 'month_end_note':
      return `On ${dateLabel}, post month-end note ${noteNumber} from the attached Month-end Notes document.`;
    case 'sales_register':
      // Batch-level companion to the sales invoices, never a transaction's
      // own document (documentTypeForVoucher never returns it).
      throw new Error('sales_register is not a per-transaction document type.');
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
  // priorKeys: the learner's earlier answer keys, so an invoice adjusting a
  // service advance received in an earlier month is described as services.
  params: { companyName: string; monthLabel: string; priorKeys?: AnswerKey[] },
): DocumentsModePlan {
  const legsBySequence = new Map<number, Entry[]>();
  for (const entry of generated.answer_key.entries) {
    const legs = legsBySequence.get(entry.sequence) ?? [];
    legs.push(entry);
    legsBySequence.set(entry.sequence, legs);
  }
  const serviceAdvances = serviceAdvanceReferences([...(params.priorKeys ?? []), generated.answer_key]);

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
      const customer = partyLegOf(legs, 'Sales');
      const serviceSupply =
        customer !== undefined &&
        parseBillReferences(referenceOf(legs)).some((parsed) => serviceAdvances.has(`${customer.correct_account}|${normalizeBillReference(parsed.ref)}`));
      salesInvoices.push({
        sequence: transaction.sequence,
        content: buildSalesInvoiceContent(legs, transaction.description, params.companyName, { serviceSupply }),
      });
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
    counts.sales > 0 ? `${counts.sales} sales invoice${counts.sales === 1 ? '' : 's'} or cash memo${counts.sales === 1 ? '' : 's'} (plus one sales register CSV for AI Accountant)` : null,
    counts.bank > 0 ? 'one bank statement' : null,
    notes.length > 0 ? 'one month-end notes sheet' : null,
  ].filter((part): part is string => part !== null);
  // Documents only (2026-09-10): the learner sees this one line and the
  // document cards, nothing else — no story, no opening position, no
  // transaction list. The pointer lines built above are kept on the stored
  // transactions for scoring labels and coaching, but never rendered
  // (documents_only). Real work arrives as paperwork, not as a brief.
  const documentCount = counts.invoices + counts.sales + (counts.bank > 0 ? 1 : 0) + (notes.length > 0 ? 1 : 0) + (counts.sales > 0 ? 1 : 0);
  const coverNote = `${params.monthLabel}: ${documentCount} documents attached, ${parts.join(', ')}. Post every entry they contain in Tally, then export the month's Day Book and Trial Balance.`;

  return {
    generated: {
      ...generated,
      scenario: coverNote,
      transactions,
      documents_only: true,
      answer_key: { ...generated.answer_key, entries },
    },
    salesInvoices,
    monthEndNotes:
      notes.length > 0 ? { companyName: params.companyName, period: params.monthLabel, notes } : null,
    salesRegister: buildSalesRegisterContent(
      salesInvoices.map((sale) => sale.content),
      { period: params.monthLabel },
    ),
  };
}
