import { z } from 'zod';
import { EXERCISE_DIFFICULTY_LEVELS } from '@/lib/schemas/exercise';

// The batch plan (2026-09-22, rebuild Stage 3): what the model returns
// instead of a ledger. Commercial facts and intents only: who, when, what
// was supplied at what rate, which bills a payment settles. Deliberately
// absent, because code computes them from the books and the party master:
// ledger legs, Dr/Cr, GST heads and amounts, TDS, bill_reference strings,
// concept tags, dates in prose. A key error of any of those classes cannot
// be authored any more; it can only be a builder bug, which a test catches.
//
// v1 covered the core six events (sale, purchase, receipt, payment, contra,
// depreciation). Stage 6 (2026-09-22, same day) added what the remaining
// concepts need: a receipt where the customer withheld TDS, credit and
// debit notes against an open bill, and reverse charge, which is not an
// event at all: the builder applies it to a purchase whenever the rulebook
// category is mandatory for that vendor and ledger (an advocate's fee, a
// goods transport agency), and books the RCM journal itself.

export const PartyRefSchema = z.object({
  // The ledger name; matched to the company's party master by canonical key.
  name: z.string().min(1),
  new_party: z.boolean(),
});
export type PartyRef = z.infer<typeof PartyRefSchema>;

const Money = z.number().positive();

export const LineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  // Taxable rate per unit; amount, tax and total are computed.
  rate: Money,
});
export type LineItem = z.infer<typeof LineItemSchema>;

// What a receipt or payment settles. No amount on a full settlement: the
// books know what is open.
export const SettlementSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('full'), bills: z.array(z.string().min(1)).min(1) }),
  z.object({ mode: z.literal('part'), bill: z.string().min(1), amount: Money }),
  z.object({ mode: z.literal('advance'), amount: Money }),
  z.object({ mode: z.literal('on_account'), amount: Money, why: z.string().min(1) }),
]);
export type Settlement = z.infer<typeof SettlementSchema>;

const Day = z.number().int().min(1).max(31);
const Seq = z.number().int().positive();

export const SaleEventSchema = z.object({
  type: z.literal('sale'),
  seq: Seq,
  day: Day,
  customer: PartyRefSchema,
  // goods -> Sales; service -> Service Income. Only a service invoice can
  // later be paid net of TDS (194J/194C do not apply to a sale of goods).
  nature: z.enum(['goods', 'service']),
  lines: z.array(LineItemSchema).min(1),
  // Combined GST slab (18 for CGST 9 + SGST 9). The head comes from the
  // customer's state.
  gst_rate: z.number(),
  // credit: New Ref invoice. cash: a counter sale (cash memo). adjust_advance:
  // the invoice adjusts the customer's open advance named below.
  settlement: z.enum(['credit', 'cash', 'adjust_advance']),
  adjust_advance_ref: z.string().nullable(),
  doc_number: z.string().min(1),
});

export const PurchaseEventSchema = z.object({
  type: z.literal('purchase'),
  seq: Seq,
  day: Day,
  vendor: PartyRefSchema,
  // goods -> Purchases; asset -> the asset ledger; service/expense -> the
  // expense ledger, with TDS where the section and threshold apply.
  nature: z.enum(['goods', 'service', 'expense', 'asset']),
  // Required unless nature is goods: "Legal & Professional Charges",
  // "Office Equipment".
  ledger: z.string().nullable(),
  lines: z.array(LineItemSchema).min(1),
  // null: no GST on the bill (exempt supply).
  gst_rate: z.number().nullable(),
  settlement: z.enum(['credit', 'adjust_advance']),
  adjust_advance_ref: z.string().nullable(),
  doc_number: z.string().min(1),
});

export const ReceiptEventSchema = z.object({
  type: z.literal('receipt'),
  seq: Seq,
  day: Day,
  customer: PartyRefSchema,
  instrument: z.enum(['bank', 'cash']),
  settlement: SettlementSchema,
  // The customer paid net of TDS under this section (rulebook 7.2): the
  // system computes the deduction on the settled invoices' taxable value
  // and books TDS Receivable. Only on a settlement of bills.
  tds_withheld: z.enum(['194J', '194C']).nullable(),
});

// A sales return: our credit note against one open invoice of the customer,
// at the invoice's slab. The system reverses the output GST and settles
// the invoice by the note's total.
export const CreditNoteEventSchema = z.object({
  type: z.literal('credit_note'),
  seq: Seq,
  day: Day,
  customer: PartyRefSchema,
  against_bill: z.string().min(1),
  lines: z.array(LineItemSchema).min(1),
  gst_rate: z.number(),
  note_number: z.string().min(1),
});

// A purchase return: our debit note against one open bill of the vendor.
export const DebitNoteEventSchema = z.object({
  type: z.literal('debit_note'),
  seq: Seq,
  day: Day,
  vendor: PartyRefSchema,
  against_bill: z.string().min(1),
  lines: z.array(LineItemSchema).min(1),
  gst_rate: z.number().nullable(),
  note_number: z.string().min(1),
});

export const PaymentEventSchema = z.object({
  type: z.literal('payment'),
  seq: Seq,
  day: Day,
  // A party payment names the payee and a settlement; a direct expense
  // (no bill) names the expense ledger and the amount instead.
  payee: PartyRefSchema.nullable(),
  settlement: SettlementSchema.nullable(),
  expense_ledger: z.string().nullable(),
  amount: Money.nullable(),
  instrument: z.enum(['bank', 'cash']),
});

export const ContraEventSchema = z.object({
  type: z.literal('contra'),
  seq: Seq,
  day: Day,
  direction: z.enum(['cash_to_bank', 'bank_to_cash']),
  amount: Money,
});

export const DepreciationEventSchema = z.object({
  type: z.literal('depreciation'),
  seq: Seq,
  day: Day,
  asset_ledger: z.string().min(1),
  // Months of depreciation charged; the amount is computed from the asset
  // ledger's balance at the stated annual rate.
  months: z.number().int().min(1).max(12),
  annual_rate_percent: z.number().positive().max(100),
});

export const BatchEventSchema = z.discriminatedUnion('type', [
  SaleEventSchema,
  PurchaseEventSchema,
  ReceiptEventSchema,
  PaymentEventSchema,
  ContraEventSchema,
  DepreciationEventSchema,
  CreditNoteEventSchema,
  DebitNoteEventSchema,
]);
export type BatchEvent = z.infer<typeof BatchEventSchema>;

export const BatchPlanSchema = z.object({
  // Two or three sentences of story, no figures (the system prints the
  // opening position itself).
  scenario: z.string().min(1),
  events: z.array(BatchEventSchema).min(1).max(14),
  difficulty_level: z.enum(EXERCISE_DIFFICULTY_LEVELS),
});
export type BatchPlan = z.infer<typeof BatchPlanSchema>;
