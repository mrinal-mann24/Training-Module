import type { AnswerKey, GeneratedExercise } from '@/lib/schemas/exercise';
import type { LicenseMode } from '@/lib/schemas/onboarding';
import { allocationsFromReference, formatBillReference, parseBillReferences } from '@/lib/tutor/bill-reference';
import { checkEducationalDates } from '@/lib/tutor/educational-dates';
import { buildVendorInvoiceContent } from '@/lib/documents/build-vendor-invoice';
import { checkSalesInvoicesBuildable } from '@/lib/tutor/documents-mode';
import { planSourceDocuments, runGenerationChecks, type ExerciseMonth } from '@/lib/tutor/generate-exercise';
import { priorBillReferences, tdsHistoryFromKeys } from '@/lib/tutor/generation-checks';
import { applyKey, cashPositionOf, cloneLedgerState, openBillsOf, openingBalancesOf, type LedgerState } from '@/lib/tutor/ledger-state';
import { payeeTypeFor, type PartyMaster } from '@/lib/tutor/party-master';

// The final invariant (2026-09-22, rebuild Stage 4): run ONCE on the object
// that is about to be persisted, after the month-end journals, the dating,
// documents mode and the bank references. The legacy loop checked the
// model's batch and then changed it in four places; whatever this returns
// is what the learner gets.
//
// Every legacy check is reused (they are proven on live data); what is new
// is the replay of the whole history plus this key through LedgerState:
// no bill overpaid, the stamped openings equal to the books, every
// reference round-tripping through the one formatter.

export type Violation = { code: string; message: string };

export type KeyInvariantInput = {
  priorKeys: AnswerKey[];
  // The books before this batch (replayKeys(priorKeys)).
  state: LedgerState;
  generated: GeneratedExercise;
  master: PartyMaster;
  month: ExerciseMonth;
  licenseMode: LicenseMode;
  companyName: string;
  documentsMode: boolean;
  // Index of this batch among the learner's keys (0 = the April pack).
  ordinal: number;
};

export function assertKeyValid(input: KeyInvariantInput): Violation[] {
  const violations: Violation[] = [];
  const { generated, state } = input;
  const yearStartIndex = Math.floor(input.ordinal / 12) * 12;

  const { hard } = runGenerationChecks(generated, {
    month: input.month,
    cashPosition: cashPositionOf(state),
    openBills: openBillsOf(state),
    // The master is the authority on a party's state and constitution; the
    // history-derived tax classes are not consulted.
    partyTaxClasses: new Map(),
    priorRefs: priorBillReferences(input.priorKeys),
    tdsHistory: tdsHistoryFromKeys(input.priorKeys.slice(yearStartIndex)),
    // Not the model's documents-mode checks: this object is already past
    // applyDocumentsMode, so a journal's line is a pointer to the notes
    // sheet built from its full text, and the code-appended GST set-off
    // states no figure on purpose. checkMonthEndNoteDetails polices a
    // model's figure-less journal and would reject every such batch (first
    // dry run, 2026-09-22). What matters here is checked below: every
    // document the batch needs can actually be built.
    documentsMode: false,
    companyName: input.companyName,
    stateCodeOf: (party) => input.master.resolve(party).stateCode,
    payeeTypeOf: (party) => payeeTypeFor(input.master.resolve(party)),
  });
  for (const message of hard) violations.push({ code: codeOf(message), message });

  // DOCUMENTS: a document that cannot be printed from the key is a plan
  // problem to retry, not a crash after the loop (buildVendorInvoiceContent
  // and buildSalesInvoiceContent throw on legs they cannot print).
  if (input.documentsMode) {
    const sales = checkSalesInvoicesBuildable(generated, input.companyName);
    if (sales) violations.push({ code: 'DOCUMENTS', message: sales });
  }
  for (const invoice of planSourceDocuments(generated).invoices) {
    try {
      buildVendorInvoiceContent(invoice.legs, invoice.transactionDescription, input.companyName);
    } catch (error) {
      violations.push({ code: 'DOCUMENTS', message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (input.licenseMode === 'educational') {
    const message = checkEducationalDates(generated, { monthIndex: input.month.monthIndex, year: input.month.year });
    if (message) violations.push({ code: 'DATES', message });
  }

  // REPLAY: the books after this key hold no overpaid bill and no negative cash.
  const after = cloneLedgerState(state);
  applyKey(after, generated.answer_key);
  for (const bill of after.bills.values()) {
    if (bill.open < -0.5) {
      violations.push({ code: 'REPLAY', message: `${bill.party}: bill ${bill.ref} would be overpaid by Rs ${Math.round(-bill.open).toLocaleString('en-IN')}` });
    }
  }
  const position = cashPositionOf(after);
  if (position.cash < -0.5) violations.push({ code: 'NEGATIVE_CASH', message: `the batch closes with cash at Rs ${Math.round(position.cash).toLocaleString('en-IN')}` });

  // OPENINGS: the stamped carry-forward equals the books before the batch.
  const expected = openingBalancesOf(state);
  const stamped = generated.answer_key.opening_balances ?? [];
  const signed = (opening: { dr_cr: 'Dr' | 'Cr'; amount: number }) => (opening.dr_cr === 'Dr' ? opening.amount : -opening.amount);
  const stampedBy = new Map(stamped.map((opening) => [opening.account, signed(opening)]));
  for (const opening of expected) {
    if (Math.abs((stampedBy.get(opening.account) ?? 0) - signed(opening)) >= 0.5) {
      violations.push({ code: 'OPENINGS', message: `opening balance of ${opening.account} is not the books' Rs ${Math.round(signed(opening)).toLocaleString('en-IN')}` });
    }
  }

  // REFERENCE_ROUNDTRIP: every reference the key carries is one the
  // formatter would produce, so scoring reads it back exactly.
  for (const entry of generated.answer_key.entries) {
    if (!entry.bill_reference) continue;
    const roundTrip = formatBillReference(allocationsFromReference(entry.bill_reference));
    const same = JSON.stringify(parseBillReferences(roundTrip)) === JSON.stringify(parseBillReferences(entry.bill_reference));
    if (!same) {
      violations.push({ code: 'REFERENCE_ROUNDTRIP', message: `transaction ${entry.sequence}: reference "${entry.bill_reference}" does not round-trip through the formatter` });
    }
  }

  return violations;
}

function codeOf(message: string): string {
  const head = message.split(':')[0].trim().toUpperCase().replace(/[^A-Z]+/g, '_').replace(/_VIOLATED$/, '');
  return head.slice(0, 40) || 'CHECK';
}
