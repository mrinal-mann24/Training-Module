import type { BatchEvent, BatchPlan, LineItem } from '@/lib/schemas/batch-plan';
import type { AnswerKeyEntry, ExerciseDifficultyLevel, GeneratedExercise } from '@/lib/schemas/exercise';
import type { LicenseMode } from '@/lib/schemas/onboarding';
import type { SourceDocumentType } from '@/lib/schemas/source-document';
import { canonicalRef, formatBillReference, looksLikeDate, type Allocation } from '@/lib/tutor/bill-reference';
import { daysInMonth, educationalDayFor } from '@/lib/tutor/educational-dates';
import { applyVoucher, cashPositionOf, cloneLedgerState, openItemsOf, type LedgerState, type OpenItem } from '@/lib/tutor/ledger-state';
import type { PartyMaster, PartyRecord } from '@/lib/tutor/party-master';
import type { CalendarDate } from '@/lib/tutor/tax-rules';
import { findOpenAdvance, resolveSettlement } from './allocate';
import { conceptTagsFor } from './concept-tags';
import { allocationPhrase, describeVoucher, type DescribedVoucher } from './describe';
import type { EventMenu } from './event-menu';
import { gstEntry, gstLegsFor, newTdsTracker, round2, tdsDecisionFor, type BuiltLeg, type TdsDecision } from './tax';

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

export type BuildKeyResult = { generated: GeneratedExercise; violations: string[] } | { generated: null; violations: string[] };

const CASH = 'Cash';
const SALES = 'Sales';
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

  dated.forEach(({ event, date }, index) => {
    const sequence = index + 1;
    const result = buildEvent({ event, date, sequence, working, input, mintAdvance, claimDocumentNumber, tracker, violations });
    if (!result) return;
    const docType = documentTypeFor(event, input.documentsMode);
    const tags = conceptTagsFor(result.legs, { assetPurchase: event.type === 'purchase' && event.nature === 'asset' });
    const fullLegs: AnswerKeyEntry[] = result.legs.map((item) => ({
      ...item,
      concept_tags: tags,
      requires_source_document: docType !== null,
      source_document_type: docType,
    }));
    applyVoucher(working, fullLegs);
    const position = cashPositionOf(working);
    if (position.cash < -0.5) {
      violations.push(`transaction ${sequence} drives cash to Rs ${Math.round(position.cash).toLocaleString('en-IN')}; cash can never go negative`);
    }
    if (position.bank < -0.5) {
      violations.push(`transaction ${sequence} overdraws the bank to Rs ${Math.round(position.bank).toLocaleString('en-IN')}`);
    }
    entries.push(...fullLegs);
    transactions.push({ sequence, description: describeVoucher(result.voucher, date, docType !== null) });
  });

  if (violations.length > 0) return { generated: null, violations };

  return {
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
};

type EventResult = { legs: BuiltLeg[]; voucher: DescribedVoucher };

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
      const taxable = lineTotal(event.lines);
      const customer = event.settlement === 'cash' ? null : input.master.resolve(event.customer.name);
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
        if (event.settlement === 'adjust_advance') {
          if (!input.menu.allowAdvances) violations.push(`transaction ${sequence}: advances are not allowed at this level`);
          const adjusted = adjustAdvance({ context, party: customer, side: 'receivable', ref: event.adjust_advance_ref, total, documentNumber: event.doc_number });
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
          leg(sequence, 'Sales', SALES, 'Cr', taxable),
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
      const vendor = input.master.resolve(event.vendor.name);
      const ledger = event.nature === 'goods' ? PURCHASES : event.ledger?.trim() || null;
      if (!ledger) {
        violations.push(`transaction ${sequence}: a ${event.nature} purchase must name its ledger`);
        return null;
      }
      if (event.nature === 'asset' && !input.menu.allowAssets) violations.push(`transaction ${sequence}: asset purchases are not allowed at this level`);
      const taxable = lineTotal(event.lines);
      const gst = event.gst_rate === null ? { legs: [], violation: null } : gstLegsFor(taxable, event.gst_rate, vendor, 'input', date);
      if (gst.violation) {
        violations.push(`transaction ${sequence}: ${gst.violation}`);
        return null;
      }
      const gstTotal = round2(gst.legs.reduce((sum, item) => sum + item.amount, 0));
      const total = round2(taxable + gstTotal);
      const tds: TdsDecision =
        event.nature === 'service' || event.nature === 'expense'
          ? tdsDecisionFor({ party: vendor, expenseLedger: ledger, taxable, date, tracker: context.tracker })
          : { applies: false, section: null };
      const partyAmount = round2(total - (tds.applies ? tds.amount : 0));
      let allocations: Allocation[];
      let consumed: { ref: string; amount: number } | null = null;
      if (event.settlement === 'adjust_advance') {
        if (!input.menu.allowAdvances) violations.push(`transaction ${sequence}: advances are not allowed at this level`);
        const adjusted = adjustAdvance({ context, party: vendor, side: 'payable', ref: event.adjust_advance_ref, total: partyAmount, documentNumber: event.doc_number });
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
        },
      };
    }

    case 'receipt': {
      const customer = input.master.resolve(event.customer.name);
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
      const legs = stampReference(
        [leg(sequence, 'Receipt', instrument, 'Dr', resolved.amount), leg(sequence, 'Receipt', customer.ledgerName, 'Cr', resolved.amount)],
        reference,
      );
      return {
        legs,
        voucher: { kind: 'receipt', customer: customer.ledgerName, instrument: event.instrument, amount: resolved.amount, allocation: allocationPhrase(resolved.allocations) },
      };
    }

    case 'payment': {
      const instrument = event.instrument === 'bank' ? bank : CASH;
      if (event.payee) {
        if (!event.settlement) {
          violations.push(`transaction ${sequence}: a payment to a party needs a settlement`);
          return null;
        }
        const payee = input.master.resolve(event.payee.name);
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
        violations.push(`transaction ${sequence}: a direct expense payment needs expense_ledger and amount`);
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
