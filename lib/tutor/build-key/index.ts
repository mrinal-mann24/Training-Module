import type { BatchEvent, BatchPlan, LineItem } from '@/lib/schemas/batch-plan';
import type { AnswerKeyEntry, ExerciseDifficultyLevel, GeneratedExercise } from '@/lib/schemas/exercise';
import type { LicenseMode } from '@/lib/schemas/onboarding';
import type { SourceDocumentType } from '@/lib/schemas/source-document';
import { canonicalRef, formatBillReference, looksLikeDate, type Allocation } from '@/lib/tutor/bill-reference';
import { daysInMonth, educationalDayFor } from '@/lib/tutor/educational-dates';
import { applyVoucher, billTaxableRatioOf, cashPositionOf, cloneLedgerState, isServiceBill, openItemsOf, referenceKey, type LedgerState, type OpenItem } from '@/lib/tutor/ledger-state';
import type { PartyMaster, PartyRecord } from '@/lib/tutor/party-master';
import { reverseChargeCategoryFor, type CalendarDate } from '@/lib/tutor/tax-rules';
import { findOpenAdvance, resolveSettlement } from './allocate';
import { conceptTagsFor } from './concept-tags';
import { allocationPhrase, describeVoucher, type DescribedVoucher } from './describe';
import type { EventMenu } from './event-menu';
import {
  assetLedgerViolation,
  documentNumberViolation,
  ledgerViolation,
  lineDescriptionViolation,
  loosePartyKey,
  partyNameViolation,
  purchaseNatureViolation,
  scenarioViolation,
} from './validate';
import { gstEntry, gstLegsFor, newTdsTracker, rcmLegsFor, round2, tdsDecisionFor, tdsWithheldFor, type BuiltLeg, type TdsDecision } from './tax';

// The deterministic key builder (2026-09-22, rebuild Stage 3): a batch
// plan (commercial facts and intents) plus the books (LedgerState) and the
// party master become every ledger leg, allocation, tax figure, concept tag
// and learner-facing line. The model never writes a number the code can
// compute; a plan that asks for something the books cannot support (a bill
// that is not open, a reused document number, cash going negative) is
// returned as violations for the retry, never built.

export type BuildKeyInput = {
  plan: BatchPlan;
  // The books before this batch, replayed from every prior key.
  state: LedgerState;
  master: PartyMaster;
  menu: EventMenu;
  month: { monthIndex: number; year: number };
  difficultyLevel: ExerciseDifficultyLevel;
  licenseMode: LicenseMode;
  bankAccount: string;
  // Every document and advance number raised before this batch, as written.
  usedDocumentNumbers: readonly string[];
  // tdsHistoryFromKeys over this financial year's prior keys.
  tdsHistory: ReadonlyMap<string, number>;
  // Documents mode: every sale, purchase and bank movement is document-backed.
  documentsMode: boolean;
};

// documentLines: the plan's own line items per sale/purchase sequence, for
// the printed invoice (rebuild Stage 5); the key itself carries only totals.
export type BuildKeyResult =
  | { generated: GeneratedExercise; documentLines: Map<number, LineItem[]>; derivedSequences: number[]; violations: string[] }
  | { generated: null; violations: string[] };

const CASH = 'Cash';
const SALES = 'Sales';
const SERVICE_INCOME = 'Service Income';
const PURCHASES = 'Purchases';
const DEPRECIATION = 'Depreciation';

function leg(sequence: number, voucherType: string, account: string, drCr: 'Dr' | 'Cr', amount: number, extra: Partial<BuiltLeg> = {}): BuiltLeg {
  return {
    sequence,
    correct_account: account,
    dr_cr: drCr,
    amount: round2(amount),
    voucher_type: voucherType,
    gst_head: null,
    gst_rate: null,
    tds_section: null,
    tds_rate: null,
    tds_base: null,
    bill_reference: null,
    narration: null,
    ...extra,
  };
}

function lineTotal(lines: readonly LineItem[]): number {
  return round2(lines.reduce((sum, line) => sum + round2(line.quantity * line.rate), 0));
}

function linesText(lines: readonly LineItem[]): string {
  // "at Rs 500 each": the text check reads a figure followed by "each" as a
  // unit rate, not a voucher figure.
  return lines.map((line) => `${line.quantity} ${line.description} at Rs ${line.rate.toLocaleString('en-IN')} each`).join(', ');
}

function gstLabel(legs: readonly { account: string }[]): string {
  return legs.some((item) => /igst/i.test(item.account)) ? 'IGST' : 'CGST and SGST';
}

function tdsSummary(decision: TdsDecision): { section: string; amount: number } | null {
  return decision.applies ? { section: decision.section, amount: decision.amount } : null;
}

function documentTypeFor(event: BatchEvent, documentsMode: boolean): SourceDocumentType | null {
  switch (event.type) {
    case 'purchase':
      return 'vendor_invoice';
    case 'sale':
      return documentsMode ? 'sales_invoice' : null;
    case 'receipt':
    case 'payment':
      return event.instrument === 'bank' ? 'bank_statement' : null;
    case 'contra':
      return 'bank_statement';
    case 'depreciation':
    case 'credit_note':
    case 'debit_note':
      return documentsMode ? 'month_end_note' : null;
    default: {
      const never: never = event;
      throw new Error(`Unknown event ${JSON.stringify(never)}`);
    }
  }
}

export function buildAnswerKey(input: BuildKeyInput): BuildKeyResult {
  const violations: string[] = [];
  const { plan, menu, month } = input;
  const monthDays = daysInMonth(month.monthIndex, month.year);

  if (plan.events.length < menu.minEvents || plan.events.length > menu.maxEvents) {
    violations.push(`the batch has ${plan.events.length} events; it needs ${menu.minEvents} to ${menu.maxEvents}`);
  }
  const seqs = new Set<number>();
  for (const event of plan.events) {
    if (seqs.has(event.seq)) violations.push(`event seq ${event.seq} appears twice`);
    seqs.add(event.seq);
    if (!menu.allowedTypes.includes(event.type)) violations.push(`event ${event.seq}: type "${event.type}" is not allowed at this level`);
  }
  const scenarioProblem = scenarioViolation(plan.scenario, month.year);
  if (scenarioProblem) violations.push(scenarioProblem);
  if (violations.length > 0) return { generated: null, violations };

  // Dates: a licensed learner posts on the day the plan says (clamped to
  // the month); an educational one on the nearest day Tally will save.
  const dated = plan.events
    .map((event) => {
      const day = Math.min(event.day, monthDays);
      const effective = input.licenseMode === 'educational' ? educationalDayFor(day, month.monthIndex, month.year) : day;
      return { event, date: { day: effective, monthIndex: month.monthIndex, year: month.year } as CalendarDate };
    })
    .sort((a, b) => a.date.day - b.date.day || a.event.seq - b.event.seq);

  const working = cloneLedgerState(input.state);
  const usedRefs = new Set(input.usedDocumentNumbers.map((ref) => canonicalRef(ref)).filter((ref): ref is string => ref !== null));
  const tracker = newTdsTracker(input.tdsHistory);
  const advanceCounter = { C: 0, S: 0 };
  for (const ref of usedRefs) {
    const match = /^ADV-([CS])-?(\d+)$/i.exec(ref);
    if (match) {
      const side = match[1].toUpperCase() as 'C' | 'S';
      advanceCounter[side] = Math.max(advanceCounter[side], Number(match[2]));
    }
  }
  const mintAdvance = (side: 'C' | 'S'): string => {
    advanceCounter[side] += 1;
    return `ADV-${side}${String(advanceCounter[side]).padStart(2, '0')}`;
  };
  const claimDocumentNumber = (sequence: number, number: string): boolean => {
    const shape = documentNumberViolation(number);
    if (shape) {
      violations.push(`transaction ${sequence}: ${shape}`);
      return false;
    }
    const key = canonicalRef(number);
    if (!key) {
      violations.push(`transaction ${sequence}: "${number}" is not a usable document number`);
      return false;
    }
    if (looksLikeDate(number)) {
      violations.push(`transaction ${sequence}: document number "${number}" looks like a date; use a plain serial number`);
      return false;
    }
    if (usedRefs.has(key)) {
      violations.push(`transaction ${sequence}: document number ${number} is already used in the books; pick a fresh one`);
      return false;
    }
    usedRefs.add(key);
    return true;
  };

  const entries: AnswerKeyEntry[] = [];
  const transactions: GeneratedExercise['transactions'] = [];
  const documentLines = new Map<number, LineItem[]>();
  // New parties this plan has already introduced, so a later event may name
  // them again without new_party.
  const batchParties = new Set<string>();
  // Vouchers code derived from an event (the RCM journal of a legal bill):
  // part of the batch, but not one of the model's events.
  const derivedSequences: number[] = [];

  let sequence = 0;
  for (const { event, date } of dated) {
    sequence += 1;
    const result = buildEvent({ event, date, sequence, working, input, mintAdvance, claimDocumentNumber, tracker, violations, batchParties });
    if (!result) continue;
    if (event.type === 'sale' || event.type === 'purchase') documentLines.set(sequence, event.lines.map((line) => ({ ...line })));
    const vouchers: { legs: BuiltLeg[]; voucher: DescribedVoucher; docType: SourceDocumentType | null }[] = [
      { legs: result.legs, voucher: result.voucher, docType: documentTypeFor(event, input.documentsMode) },
    ];
    // A derived voucher (the RCM journal of a reverse-charge bill, Stage 6)
    // follows its event under the next sequence.
    if (result.derived) {
      sequence += 1;
      derivedSequences.push(sequence);
      vouchers.push({
        legs: result.derived.legs.map((item) => ({ ...item, sequence })),
        voucher: result.derived.voucher,
        docType: input.documentsMode ? 'month_end_note' : null,
      });
    }
    for (const { legs: built, voucher, docType } of vouchers) {
      const seq = built[0]?.sequence ?? sequence;
      // The learner's line states whole rupees while the key and the scorer
      // are exact, so a figure with paise would read wrong in the text.
      const paise = built.find((item) => Math.abs(item.amount - Math.round(item.amount)) > 0.004);
      if (paise) {
        violations.push(`transaction ${seq}: ${paise.correct_account} comes to Rs ${paise.amount.toFixed(2)}; choose quantities and rates so every figure, GST included, is a whole rupee`);
      }
      const tags = conceptTagsFor(built, { assetPurchase: event.type === 'purchase' && event.nature === 'asset' });
      const fullLegs: AnswerKeyEntry[] = built.map((item) => ({
        ...item,
        concept_tags: tags,
        requires_source_document: docType !== null,
        source_document_type: docType,
      }));
      applyVoucher(working, fullLegs);
      const position = cashPositionOf(working);
      if (position.cash < -0.5) {
        violations.push(`transaction ${seq} drives cash to Rs ${Math.round(position.cash).toLocaleString('en-IN')}; cash can never go negative`);
      }
      if (position.bank < -0.5) {
        violations.push(`transaction ${seq} overdraws the bank to Rs ${Math.round(position.bank).toLocaleString('en-IN')}`);
      }
      entries.push(...fullLegs);
      transactions.push({ sequence: seq, description: describeVoucher(voucher, date, docType !== null) });
    }
  }

  if (violations.length > 0) return { generated: null, violations };

  return {
    documentLines,
    derivedSequences,
    generated: {
      scenario: plan.scenario.trim(),
      transactions,
      difficulty_level: input.difficultyLevel,
      variant: 'A',
      answer_key: { entries },
    },
    violations: [],
  };
}

type EventContext = {
  event: BatchEvent;
  date: CalendarDate;
  sequence: number;
  working: LedgerState;
  input: BuildKeyInput;
  mintAdvance: (side: 'C' | 'S') => string;
  claimDocumentNumber: (sequence: number, number: string) => boolean;
  tracker: ReturnType<typeof newTdsTracker>;
  violations: string[];
  batchParties: Set<string>;
};

// The party a plan names, refused when the name would be read as another
// kind of ledger, is a second spelling of an existing party, or is unknown
// without new_party. Null after pushing the violation.
function resolveParty(context: EventContext, ref: { name: string; new_party: boolean }): PartyRecord | null {
  const problem = partyNameViolation({ name: ref.name, newParty: ref.new_party, master: context.input.master, raisedInBatch: context.batchParties });
  if (problem) {
    context.violations.push(`transaction ${context.sequence}: ${problem}`);
    return null;
  }
  const party = context.input.master.resolve(ref.name);
  if (!party.known) context.batchParties.add(loosePartyKey(ref.name));
  return party;
}

// A bill or invoice for a party that holds an open advance ALWAYS adjusts
// it, whatever the plan said: that is what a bookkeeper does, the legacy
// engine did it in code after validation, and a learner who adjusts it
// would otherwise be scored against a key that booked the whole document as
// new (dry run, Praveen's Bharat Machinery, 2026-09-22).
function advanceToAdjust(context: EventContext, party: PartyRecord, side: OpenItem['side'], planned: string | null): string | null {
  if (planned) return planned;
  const open = openItemsOf(context.working).find((item) => item.kind === 'advance' && item.party === party.ledgerName && item.side === side);
  return open?.ref ?? null;
}

function linesOk(context: EventContext, lines: readonly LineItem[]): boolean {
  let ok = true;
  for (const line of lines) {
    const problem = lineDescriptionViolation(line.description);
    if (problem) {
      context.violations.push(`transaction ${context.sequence}: ${problem}`);
      ok = false;
    }
  }
  return ok;
}

type EventResult = { legs: BuiltLeg[]; voucher: DescribedVoucher; derived?: { legs: BuiltLeg[]; voucher: DescribedVoucher } };

function stampReference(legs: BuiltLeg[], reference: string | null): BuiltLeg[] {
  return legs.map((item) => ({ ...item, bill_reference: reference }));
}

function adjustAdvance(params: {
  context: EventContext;
  party: PartyRecord;
  side: OpenItem['side'];
  ref: string | null;
  total: number;
  documentNumber: string;
}): { allocations: Allocation[]; consumed: { ref: string; amount: number } } | null {
  const { context, party, side, ref, total, documentNumber } = params;
  if (!ref) {
    context.violations.push(`transaction ${context.sequence}: settlement "adjust_advance" needs adjust_advance_ref`);
    return null;
  }
  const advance = findOpenAdvance({ ref, party: party.ledgerName, side, openItems: openItemsOf(context.working) });
  if (!advance) {
    const open = openItemsOf(context.working).filter((item) => item.kind === 'advance' && item.party === party.ledgerName);
    context.violations.push(
      `transaction ${context.sequence}: ${party.ledgerName} holds no open advance ${ref}${open.length > 0 ? ` (open: ${open.map((item) => `${item.ref} Rs ${Math.round(item.open).toLocaleString('en-IN')}`).join(', ')})` : ''}`,
    );
    return null;
  }
  const consumed = round2(Math.min(advance.open, total));
  const remainder = round2(total - consumed);
  if (remainder < 0.5) {
    context.violations.push(`transaction ${context.sequence}: ${documentNumber} (Rs ${Math.round(total).toLocaleString('en-IN')}) must exceed advance ${advance.ref} (Rs ${Math.round(advance.open).toLocaleString('en-IN')}) so a balance stays as a new bill`);
    return null;
  }
  return {
    allocations: [
      { ref: advance.ref, kind: 'advance', amount: consumed },
      { ref: documentNumber, kind: 'new', amount: remainder },
    ],
    consumed: { ref: advance.ref, amount: consumed },
  };
}

function buildEvent(context: EventContext): EventResult | null {
  const { event, date, sequence, input, violations } = context;
  const bank = input.bankAccount;

  switch (event.type) {
    case 'sale': {
      if (event.lines.length > input.menu.maxLinesPerDocument) violations.push(`transaction ${sequence}: at most ${input.menu.maxLinesPerDocument} line items`);
      if (!context.claimDocumentNumber(sequence, event.doc_number)) return null;
      if (!linesOk(context, event.lines)) return null;
      const taxable = lineTotal(event.lines);
      const customer = event.settlement === 'cash' ? null : resolveParty(context, event.customer);
      if (event.settlement !== 'cash' && !customer) return null;
      const gst = gstLegsFor(taxable, event.gst_rate, customer, 'output', date);
      if (gst.violation) {
        violations.push(`transaction ${sequence}: ${gst.violation}`);
        return null;
      }
      const gstTotal = round2(gst.legs.reduce((sum, item) => sum + item.amount, 0));
      const total = round2(taxable + gstTotal);
      let allocations: Allocation[] = [];
      let consumed: { ref: string; amount: number } | null = null;
      if (customer) {
        const advanceRef = advanceToAdjust(context, customer, 'receivable', event.settlement === 'adjust_advance' ? event.adjust_advance_ref : null);
        if (event.settlement === 'adjust_advance' || advanceRef) {
          if (event.settlement === 'adjust_advance' && !input.menu.allowAdvances) violations.push(`transaction ${sequence}: advances are not allowed at this level`);
          const adjusted = adjustAdvance({ context, party: customer, side: 'receivable', ref: advanceRef, total, documentNumber: event.doc_number });
          if (!adjusted) return null;
          allocations = adjusted.allocations;
          consumed = adjusted.consumed;
        } else {
          allocations = [{ ref: event.doc_number, kind: 'new', amount: total }];
        }
      }
      const reference = customer ? formatBillReference(allocations) : null;
      const legs = stampReference(
        [
          leg(sequence, 'Sales', customer ? customer.ledgerName : CASH, 'Dr', total),
          leg(sequence, 'Sales', event.nature === 'service' ? SERVICE_INCOME : SALES, 'Cr', taxable),
          ...gst.legs.map((item) => gstEntry(sequence, 'Sales', item, 'Cr')),
        ],
        reference,
      );
      return {
        legs,
        voucher: {
          kind: 'sale',
          customer: customer?.ledgerName ?? null,
          documentNumber: event.doc_number,
          lines: linesText(event.lines),
          taxable,
          gst: gstTotal,
          gstLabel: gstLabel(gst.legs),
          total,
          advance: consumed,
        },
      };
    }

    case 'purchase': {
      if (event.lines.length > input.menu.maxLinesPerDocument) violations.push(`transaction ${sequence}: at most ${input.menu.maxLinesPerDocument} line items`);
      if (!context.claimDocumentNumber(sequence, event.doc_number)) return null;
      const vendor = resolveParty(context, event.vendor);
      if (!vendor || !linesOk(context, event.lines)) return null;
      const ledger = event.nature === 'goods' ? PURCHASES : event.ledger?.trim() || null;
      if (!ledger) {
        violations.push(`transaction ${sequence}: a ${event.nature} purchase must name its ledger`);
        return null;
      }
      const ledgerProblem =
        event.nature === 'goods'
          ? null
          : (ledgerViolation({ ledger, master: input.master, bankAccount: bank, role: event.nature === 'asset' ? 'asset' : 'expense' }) ?? (event.nature === 'asset' ? assetLedgerViolation(ledger) : null));
      const natureProblem = purchaseNatureViolation({ nature: event.nature, ledger, descriptions: event.lines.map((line) => line.description) });
      if (ledgerProblem || natureProblem) {
        violations.push(`transaction ${sequence}: ${ledgerProblem ?? natureProblem}`);
        return null;
      }
      if (event.nature === 'asset' && !input.menu.allowAssets) violations.push(`transaction ${sequence}: asset purchases are not allowed at this level`);
      const taxable = lineTotal(event.lines);
      // Reverse charge is the rulebook's decision, not the plan's (Stage 6):
      // an advocate's fee or a goods transport agency bill carries no vendor
      // GST; the company books the tax on itself in a journal that follows.
      const category = event.nature === 'service' || event.nature === 'expense' ? reverseChargeCategoryFor({ party: vendor.ledgerName, expenseLedgers: [ledger] }) : null;
      const reverseCharge = category?.mandatory === true;
      // A foreign supplier has no GSTIN and no Indian state; the party
      // master cannot print one, so an import is refused rather than booked
      // with a Karnataka identity and CGST/SGST under reverse charge.
      if (category?.id === 'import_of_services') {
        violations.push(`transaction ${sequence}: an import of services is not supported; use a domestic vendor`);
        return null;
      }
      if (reverseCharge && event.gst_rate === null) {
        violations.push(`transaction ${sequence}: ${category?.description ?? 'this supply'} is under reverse charge; give the purchase its GST slab in gst_rate (18 for legal services)`);
        return null;
      }
      const gst = event.gst_rate === null || reverseCharge ? { legs: [], violation: null } : gstLegsFor(taxable, event.gst_rate, vendor, 'input', date);
      if (gst.violation) {
        violations.push(`transaction ${sequence}: ${gst.violation}`);
        return null;
      }
      const rcm = reverseCharge && event.gst_rate !== null ? rcmLegsFor(taxable, event.gst_rate, vendor, date) : null;
      if (rcm?.violation) {
        violations.push(`transaction ${sequence}: ${rcm.violation}`);
        return null;
      }
      const gstTotal = round2(gst.legs.reduce((sum, item) => sum + item.amount, 0));
      const total = round2(taxable + gstTotal);
      const tds: TdsDecision =
        event.nature === 'service' || event.nature === 'expense'
          ? tdsDecisionFor({ party: vendor, expenseLedger: ledger, taxable, date, tracker: context.tracker })
          : { applies: false, section: null };
      if ((tds.applies || reverseCharge) && !input.menu.allowTds) {
        violations.push(`transaction ${sequence}: this bill carries ${reverseCharge ? 'reverse charge' : 'TDS'}, which is not allowed at this level; keep purchases to goods`);
        return null;
      }
      const partyAmount = round2(total - (tds.applies ? tds.amount : 0));
      let allocations: Allocation[];
      let consumed: { ref: string; amount: number } | null = null;
      const advanceRef = advanceToAdjust(context, vendor, 'payable', event.settlement === 'adjust_advance' ? event.adjust_advance_ref : null);
      if (event.settlement === 'adjust_advance' || advanceRef) {
        if (event.settlement === 'adjust_advance' && !input.menu.allowAdvances) violations.push(`transaction ${sequence}: advances are not allowed at this level`);
        const adjusted = adjustAdvance({ context, party: vendor, side: 'payable', ref: advanceRef, total: partyAmount, documentNumber: event.doc_number });
        if (!adjusted) return null;
        allocations = adjusted.allocations;
        consumed = adjusted.consumed;
      } else {
        allocations = [{ ref: event.doc_number, kind: 'new', amount: partyAmount }];
      }
      const reference = formatBillReference(allocations);
      const legs = stampReference(
        [
          leg(sequence, 'Purchase', ledger, 'Dr', taxable),
          ...gst.legs.map((item) => gstEntry(sequence, 'Purchase', item, 'Dr')),
          ...(tds.applies
            ? [leg(sequence, 'Purchase', tds.account, 'Cr', tds.amount, { tds_section: tds.section, tds_rate: tds.rate, tds_base: tds.base })]
            : []),
          leg(sequence, 'Purchase', vendor.ledgerName, 'Cr', partyAmount),
        ],
        reference,
      );
      const rcmTotal = rcm ? round2(rcm.input.reduce((sum, item) => sum + item.amount, 0)) : 0;
      return {
        legs,
        voucher: {
          kind: 'purchase',
          vendor: vendor.ledgerName,
          documentNumber: event.doc_number,
          ledger,
          lines: linesText(event.lines),
          taxable,
          gst: gstTotal,
          gstLabel: gstLabel(gst.legs),
          tds: tdsSummary(tds),
          total,
          advance: consumed,
          reverseCharge,
        },
        ...(rcm
          ? {
              derived: {
                legs: [
                  ...rcm.input.map((item) => gstEntry(sequence + 1, 'Journal', item, 'Dr')),
                  ...rcm.output.map((item) => gstEntry(sequence + 1, 'Journal', item, 'Cr')),
                ],
                voucher: { kind: 'rcm_journal', vendor: vendor.ledgerName, documentNumber: event.doc_number, taxable, gst: rcmTotal, gstLabel: gstLabel(rcm.input), ratePercent: event.gst_rate ?? 0 },
              },
            }
          : {}),
      };
    }

    case 'receipt': {
      const customer = resolveParty(context, event.customer);
      if (!customer) return null;
      if (event.settlement.mode === 'advance' && !input.menu.allowAdvances) violations.push(`transaction ${sequence}: advances are not allowed at this level`);
      if (event.settlement.mode === 'on_account' && !input.menu.allowOnAccount) violations.push(`transaction ${sequence}: on-account settlements are not allowed at this level`);
      if (event.settlement.mode === 'full' && event.settlement.bills.length > 1 && !input.menu.allowMultiBill) violations.push(`transaction ${sequence}: settle one bill per receipt at this level`);
      const resolved = resolveSettlement({
        settlement: event.settlement,
        party: customer.ledgerName,
        side: 'receivable',
        openItems: openItemsOf(context.working),
        nextAdvanceRef: () => context.mintAdvance('C'),
      });
      if (!resolved.ok) {
        violations.push(`transaction ${sequence}: ${resolved.violation}`);
        return null;
      }
      const reference = formatBillReference(resolved.allocations);
      const instrument = event.instrument === 'bank' ? bank : CASH;
      // TDS withheld by the customer (Stage 6): on the taxable value of the
      // invoices settled, in the proportion this receipt settles them.
      let withheld: ReturnType<typeof tdsWithheldFor> | null = null;
      if (event.tds_withheld) {
        if (!input.menu.allowTdsOnReceipt) violations.push(`transaction ${sequence}: TDS withheld on a receipt is not allowed at this level`);
        if (resolved.kind !== 'bills') {
          violations.push(`transaction ${sequence}: TDS can be withheld only on a receipt that settles invoices, not an advance or an on-account receipt`);
          return null;
        }
        let base = 0;
        for (const allocation of resolved.allocations) {
          if (!isServiceBill(context.working, customer.ledgerName, allocation.ref)) {
            violations.push(`transaction ${sequence}: ${allocation.ref} is an invoice for goods; a customer withholds TDS only on a service invoice (a sale with nature "service")`);
            return null;
          }
          const ratio = billTaxableRatioOf(context.working, customer.ledgerName, allocation.ref);
          if (ratio === null) {
            violations.push(`transaction ${sequence}: the books hold no taxable value for ${allocation.ref}; TDS cannot be withheld on an opening-balance bill`);
            return null;
          }
          base += allocation.amount * ratio;
        }
        withheld = tdsWithheldFor({ section: event.tds_withheld, base, date, customer });
      }
      const net = round2(resolved.amount - (withheld?.amount ?? 0));
      const legs = stampReference(
        [
          leg(sequence, 'Receipt', instrument, 'Dr', net),
          ...(withheld ? [leg(sequence, 'Receipt', withheld.account, 'Dr', withheld.amount, { tds_section: withheld.section, tds_rate: withheld.rate, tds_base: withheld.base })] : []),
          leg(sequence, 'Receipt', customer.ledgerName, 'Cr', resolved.amount),
        ],
        reference,
      );
      return {
        legs,
        voucher: {
          kind: 'receipt',
          customer: customer.ledgerName,
          instrument: event.instrument,
          amount: resolved.amount,
          allocation: allocationPhrase(resolved.allocations),
          tds: withheld ? { section: withheld.section, amount: withheld.amount } : null,
        },
      };
    }

    case 'credit_note':
    case 'debit_note': {
      if (!input.menu.allowNotes) violations.push(`transaction ${sequence}: credit and debit notes are not allowed at this level`);
      if (event.lines.length > input.menu.maxLinesPerDocument) violations.push(`transaction ${sequence}: at most ${input.menu.maxLinesPerDocument} line items`);
      if (!context.claimDocumentNumber(sequence, event.note_number)) return null;
      const isCredit = event.type === 'credit_note';
      const party = resolveParty(context, isCredit ? event.customer : event.vendor);
      if (!party || !linesOk(context, event.lines)) return null;
      const side: OpenItem['side'] = isCredit ? 'receivable' : 'payable';
      const open = openItemsOf(context.working).filter((item) => item.kind === 'bill' && item.party === party.ledgerName && item.side === side);
      const bill = open.find((item) => item.key === referenceKey(event.against_bill));
      if (!bill) {
        violations.push(
          `transaction ${sequence}: ${party.ledgerName} has no open bill ${event.against_bill} for a ${isCredit ? 'credit' : 'debit'} note; open: ${open.map((item) => `${item.ref} (Rs ${Math.round(item.open).toLocaleString('en-IN')})`).join(', ') || 'none'}`,
        );
        return null;
      }
      // A note reverses the bill's own GST: the slab is the one the bill was
      // raised at, read back from the taxable share the books remember.
      const ratio = billTaxableRatioOf(context.working, party.ledgerName, bill.ref);
      if (ratio !== null) {
        const raisedAt = Math.round((1 / ratio - 1) * 1000) / 10;
        if (Math.abs(raisedAt - (event.gst_rate ?? 0)) > 0.3) {
          violations.push(`transaction ${sequence}: ${bill.ref} was raised at ${raisedAt}% GST; a note against it uses the same slab (gst_rate ${raisedAt === 0 ? 'null' : raisedAt})`);
          return null;
        }
      }
      const taxable = lineTotal(event.lines);
      const gst = event.gst_rate === null ? { legs: [], violation: null } : gstLegsFor(taxable, event.gst_rate, party, isCredit ? 'output' : 'input', date);
      if (gst.violation) {
        violations.push(`transaction ${sequence}: ${gst.violation}`);
        return null;
      }
      const gstTotal = round2(gst.legs.reduce((sum, item) => sum + item.amount, 0));
      const total = round2(taxable + gstTotal);
      if (total > bill.open + 0.005) {
        violations.push(`transaction ${sequence}: the note's total Rs ${Math.round(total).toLocaleString('en-IN')} exceeds the open balance of ${bill.ref} (Rs ${Math.round(bill.open).toLocaleString('en-IN')})`);
        return null;
      }
      const reference = formatBillReference([
        { ref: bill.ref, kind: 'against', amount: total },
        { ref: event.note_number, kind: 'new', amount: total },
      ]);
      const voucherType = isCredit ? 'Credit Note' : 'Debit Note';
      const legs = stampReference(
        isCredit
          ? [leg(sequence, voucherType, 'Sales Returns', 'Dr', taxable), ...gst.legs.map((item) => gstEntry(sequence, voucherType, item, 'Dr')), leg(sequence, voucherType, party.ledgerName, 'Cr', total)]
          : [leg(sequence, voucherType, party.ledgerName, 'Dr', total), leg(sequence, voucherType, 'Purchase Returns', 'Cr', taxable), ...gst.legs.map((item) => gstEntry(sequence, voucherType, item, 'Cr'))],
        reference,
      );
      return {
        legs,
        voucher: {
          kind: isCredit ? 'credit_note' : 'debit_note',
          party: party.ledgerName,
          noteNumber: event.note_number,
          againstBill: bill.ref,
          lines: linesText(event.lines),
          taxable,
          gst: gstTotal,
          gstLabel: gstLabel(gst.legs),
          total,
        },
      };
    }

    case 'payment': {
      const instrument = event.instrument === 'bank' ? bank : CASH;
      if (event.payee) {
        if (!event.settlement) {
          violations.push(`transaction ${sequence}: a payment to a party needs a settlement`);
          return null;
        }
        const payee = resolveParty(context, event.payee);
        if (!payee) return null;
        if (event.settlement.mode === 'advance' && !input.menu.allowAdvances) violations.push(`transaction ${sequence}: advances are not allowed at this level`);
        if (event.settlement.mode === 'on_account' && !input.menu.allowOnAccount) violations.push(`transaction ${sequence}: on-account settlements are not allowed at this level`);
        if (event.settlement.mode === 'full' && event.settlement.bills.length > 1 && !input.menu.allowMultiBill) violations.push(`transaction ${sequence}: settle one bill per payment at this level`);
        const resolved = resolveSettlement({
          settlement: event.settlement,
          party: payee.ledgerName,
          side: 'payable',
          openItems: openItemsOf(context.working),
          nextAdvanceRef: () => context.mintAdvance('S'),
        });
        if (!resolved.ok) {
          violations.push(`transaction ${sequence}: ${resolved.violation}`);
          return null;
        }
        const reference = formatBillReference(resolved.allocations);
        const legs = stampReference(
          [leg(sequence, 'Payment', payee.ledgerName, 'Dr', resolved.amount), leg(sequence, 'Payment', instrument, 'Cr', resolved.amount)],
          reference,
        );
        return {
          legs,
          voucher: { kind: 'payment', payee: payee.ledgerName, expenseLedger: null, instrument: event.instrument, amount: resolved.amount, allocation: allocationPhrase(resolved.allocations), tds: null },
        };
      }
      const expenseLedger = event.expense_ledger?.trim() || null;
      if (!expenseLedger || event.amount === null) {
        violations.push(`transaction ${sequence}: a direct expense payment needs ledger and amount`);
        return null;
      }
      const expenseProblem = ledgerViolation({ ledger: expenseLedger, master: input.master, bankAccount: bank, role: 'expense' });
      if (expenseProblem) {
        violations.push(`transaction ${sequence}: ${expenseProblem}`);
        return null;
      }
      // A direct expense has no party; the threshold check keys the exposure
      // on the expense ledger itself, so the decision does the same.
      const pseudoPayee: PartyRecord = { ...input.master.resolve(expenseLedger), ledgerName: expenseLedger };
      const tds = tdsDecisionFor({ party: pseudoPayee, expenseLedger, taxable: event.amount, date, tracker: context.tracker });
      const net = round2(event.amount - (tds.applies ? tds.amount : 0));
      const legs = [
        leg(sequence, 'Payment', expenseLedger, 'Dr', event.amount),
        ...(tds.applies ? [leg(sequence, 'Payment', tds.account, 'Cr', tds.amount, { tds_section: tds.section, tds_rate: tds.rate, tds_base: tds.base })] : []),
        leg(sequence, 'Payment', instrument, 'Cr', net),
      ];
      return {
        legs,
        voucher: { kind: 'payment', payee: null, expenseLedger, instrument: event.instrument, amount: event.amount, allocation: '', tds: tdsSummary(tds) },
      };
    }

    case 'contra': {
      const legs =
        event.direction === 'cash_to_bank'
          ? [leg(sequence, 'Contra', bank, 'Dr', event.amount), leg(sequence, 'Contra', CASH, 'Cr', event.amount)]
          : [leg(sequence, 'Contra', CASH, 'Dr', event.amount), leg(sequence, 'Contra', bank, 'Cr', event.amount)];
      return { legs, voucher: { kind: 'contra', direction: event.direction, amount: event.amount } };
    }

    case 'depreciation': {
      // One month's charge per monthly batch, on a real asset ledger, at a
      // rate a fixed asset can carry.
      const depreciationProblem =
        assetLedgerViolation(event.asset_ledger) ??
        (event.months !== 1 ? 'depreciation is charged one month at a time: months must be 1' : null) ??
        (event.annual_rate_percent > 40 ? 'annual_rate_percent must be 40 or below' : null);
      if (depreciationProblem) {
        violations.push(`transaction ${sequence}: ${depreciationProblem}`);
        return null;
      }
      const balance = context.working.balances.get(event.asset_ledger) ?? 0;
      if (balance < 0.5) {
        const assets = [...context.working.balances]
          .filter(([name, value]) => value > 0 && /equipment|furniture|computer|machinery|vehicle|plant/i.test(name))
          .map(([name]) => name);
        violations.push(`transaction ${sequence}: ${event.asset_ledger} holds no balance to depreciate (asset ledgers: ${assets.join(', ') || 'none'})`);
        return null;
      }
      const amount = Math.round((balance * event.annual_rate_percent * event.months) / 1200);
      if (amount < 1) {
        violations.push(`transaction ${sequence}: depreciation on ${event.asset_ledger} rounds to nothing`);
        return null;
      }
      const legs = [leg(sequence, 'Journal', DEPRECIATION, 'Dr', amount), leg(sequence, 'Journal', event.asset_ledger, 'Cr', amount)];
      return { legs, voucher: { kind: 'depreciation', assetLedger: event.asset_ledger, months: event.months, ratePercent: event.annual_rate_percent, amount } };
    }

    default: {
      const never: never = event;
      throw new Error(`Unknown event ${JSON.stringify(never)}`);
    }
  }
}
