import { z } from 'zod';
import { BatchPlanSchema, type BatchPlan } from '@/lib/schemas/batch-plan';

// The model answers in a FLAT event shape (lib/llm/prompts/
// batch-plan-json-schema.ts: one object, nullable fields) because the typed
// union is too large a grammar for the provider's strict JSON mode
// (2026-09-22). This module turns the flat answer into the typed plan the
// builder consumes. Nothing is guessed: a field the event type needs and
// the model left null is a violation sent back to the model, named by the
// flat field the model actually writes.

const WireEventSchema = z.object({
  type: z.string(),
  seq: z.number(),
  day: z.number(),
  party: z.string().nullable(),
  new_party: z.boolean(),
  lines: z.array(z.object({ description: z.string(), quantity: z.number(), rate: z.number() })),
  gst_rate: z.number().nullable(),
  doc_number: z.string().nullable(),
  settlement: z.string().nullable(),
  adjust_advance_ref: z.string().nullable(),
  nature: z.string().nullable(),
  ledger: z.string().nullable(),
  instrument: z.string().nullable(),
  settlement_mode: z.string().nullable(),
  bills: z.array(z.string()),
  amount: z.number().nullable(),
  why: z.string().nullable(),
  tds_withheld: z.string().nullable(),
  direction: z.string().nullable(),
  months: z.number().nullable(),
  annual_rate_percent: z.number().nullable(),
});
type WireEvent = z.infer<typeof WireEventSchema>;

const WirePlanSchema = z.object({
  scenario: z.string(),
  difficulty_level: z.string(),
  events: z.array(WireEventSchema),
});

export type WireConversion = { ok: true; plan: BatchPlan } | { ok: false; violations: string[] };

function settlementOf(event: WireEvent): unknown {
  switch (event.settlement_mode) {
    case 'full':
      return { mode: 'full', bills: event.bills };
    case 'part':
      return { mode: 'part', bill: event.bills[0], amount: event.amount };
    case 'advance':
      return { mode: 'advance', amount: event.amount };
    case 'on_account':
      return { mode: 'on_account', amount: event.amount, why: event.why };
    default:
      return null;
  }
}

// The typed event the flat one describes. Fields that do not belong to the
// event's type are dropped; missing ones are left for BatchPlanSchema to
// reject, and reported under the flat names below.
function typedEventOf(event: WireEvent): unknown {
  const base = { type: event.type, seq: event.seq, day: event.day };
  const party = event.party === null ? null : { name: event.party, new_party: event.new_party };
  switch (event.type) {
    case 'sale':
      return { ...base, customer: party, nature: event.nature ?? 'goods', lines: event.lines, gst_rate: event.gst_rate, settlement: event.settlement, adjust_advance_ref: event.adjust_advance_ref, doc_number: event.doc_number };
    case 'purchase':
      return { ...base, vendor: party, nature: event.nature, ledger: event.ledger, lines: event.lines, gst_rate: event.gst_rate, settlement: event.settlement, adjust_advance_ref: event.adjust_advance_ref, doc_number: event.doc_number };
    case 'receipt':
      return { ...base, customer: party, instrument: event.instrument, settlement: settlementOf(event), tds_withheld: event.tds_withheld };
    case 'payment':
      return party
        ? { ...base, payee: party, settlement: settlementOf(event), expense_ledger: null, amount: null, instrument: event.instrument }
        : { ...base, payee: null, settlement: null, expense_ledger: event.ledger, amount: event.amount, instrument: event.instrument };
    case 'contra':
      return { ...base, direction: event.direction, amount: event.amount };
    case 'depreciation':
      return { ...base, asset_ledger: event.ledger, months: event.months, annual_rate_percent: event.annual_rate_percent };
    case 'credit_note':
      return { ...base, customer: party, against_bill: event.bills[0], lines: event.lines, gst_rate: event.gst_rate, note_number: event.doc_number };
    case 'debit_note':
      return { ...base, vendor: party, against_bill: event.bills[0], lines: event.lines, gst_rate: event.gst_rate, note_number: event.doc_number };
    default:
      return base;
  }
}

// Typed-plan paths back to the flat field the model writes.
const FLAT_FIELD: Record<string, string> = {
  customer: 'party',
  vendor: 'party',
  payee: 'party',
  against_bill: 'bills (the one bill the note is against)',
  note_number: 'doc_number',
  asset_ledger: 'ledger',
  expense_ledger: 'ledger',
  bill: 'bills (the one bill part-paid)',
  mode: 'settlement_mode',
};

export function batchPlanFromWire(raw: unknown): WireConversion {
  const wire = WirePlanSchema.safeParse(raw);
  if (!wire.success) {
    return { ok: false, violations: [`the plan did not match the schema: ${wire.error.issues.slice(0, 6).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`] };
  }
  const typed = {
    scenario: wire.data.scenario,
    difficulty_level: wire.data.difficulty_level,
    events: wire.data.events.map(typedEventOf),
  };
  const parsed = BatchPlanSchema.safeParse(typed);
  if (parsed.success) return { ok: true, plan: parsed.data };

  const violations = parsed.error.issues.slice(0, 12).map((issue) => {
    const [root, index, ...rest] = issue.path;
    if (root !== 'events' || typeof index !== 'number') return `${issue.path.join('.')}: ${issue.message}`;
    const event = wire.data.events[index];
    const settles = event?.type === 'receipt' || event?.type === 'payment';
    const field = rest.map((part) => (settles && part === 'settlement' ? 'settlement_mode' : (FLAT_FIELD[String(part)] ?? String(part)))).join('.') || 'type';
    return `event seq ${event?.seq ?? index + 1} (${event?.type ?? 'unknown type'}): "${field}" is missing or invalid for this event type (${issue.message})`;
  });
  return { ok: false, violations };
}
