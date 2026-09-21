import type { ChatMessage } from '@/lib/llm/client';
import type { ConceptTag, ExerciseDifficultyLevel } from '@/lib/schemas/exercise';
import type { OpenItem } from '@/lib/tutor/ledger-state';
import { describeMenu, type EventMenu } from '@/lib/tutor/build-key/event-menu';
import { taxRulesSummaryFor, type CalendarDate } from '@/lib/tutor/tax-rules';
import { BATCH_PLAN_JSON_SCHEMA } from './batch-plan-json-schema';

// The batch-plan prompt (2026-09-22, rebuild Stage 3). The model writes
// the month's story as commercial events; it is never asked for a ledger
// leg, a GST head, a TDS figure or a bill_reference, because the builder
// computes those from the books and the party master. Everything the
// model must respect (open bills, used numbers, allowed days, the event
// menu) is stated as data, and every violation of it is checked in code and
// fed back for one retry message.

export type BatchPlanParams = {
  companyName: string;
  monthLabel: string;
  month: CalendarDate;
  difficultyLevel: ExerciseDifficultyLevel;
  targetConcept: ConceptTag;
  strengthConcepts: ConceptTag[];
  weaknessConcepts: ConceptTag[];
  recentStrengthDescriptions: string[];
  escalationActive: boolean;
  menu: EventMenu;
  // The days a voucher may carry (Educational Mode: 1, 2 and 31 only).
  postingDays: number[] | 'any';
  parties: { name: string; state: string; role: 'customer' | 'vendor' | 'both' | 'unknown' }[];
  openItems: OpenItem[];
  cash: number;
  bank: number;
  bankAccount: string;
  usedDocumentNumbers: string[];
  // Expense and asset ledgers the company already uses.
  ledgerNames: string[];
  tdsExposure: { payee: string; section: string; paidSoFar: number }[];
  documentsMode: boolean;
};

// What each concept means commercially. No posting recipe: the builder
// posts, the model only decides that the event happens.
export const CONCEPT_STORIES: Partial<Record<ConceptTag, string>> = {
  sales_voucher_basics: 'a credit sale to a customer, or a counter sale for cash',
  purchase_voucher_basics: 'goods bought on credit from a vendor, or a service or expense bill',
  payment_voucher_basics: 'paying a vendor bill from the bank, or a direct expense',
  receipt_voucher_basics: 'a customer paying an invoice into the bank',
  contra_voucher_basics: 'cash deposited into the bank, or drawn from it, within what is held',
  journal_voucher_basics: 'a month-end adjustment such as depreciation',
  gst_classification: 'sales and purchases with GST at a real slab; the tax head follows the party state (the system computes it)',
  tds_classification: 'a service or expense bill (legal, audit, rent, contractor work) large enough for TDS to apply',
  bill_by_bill_referencing: 'bills raised and later settled by name',
  customer_advance: 'a customer paying before you invoice (settlement_mode "advance"), then an invoice that adjusts that advance (settlement "adjust_advance")',
  supplier_advance: 'paying a vendor before their bill (settlement_mode "advance"), then the bill that adjusts it (settlement "adjust_advance")',
  on_account_reference: 'a receipt or payment that no bill can be identified for (settlement_mode "on_account", with the reason in "why")',
  multi_bill_settlement: 'one receipt or payment clearing two or three open bills of the same party (settlement_mode "full" with each bill in "bills")',
  gst_set_off: 'enough GST sales and purchases in the month for a set-off to matter; the system appends the set-off itself',
  gst_payment: "nothing to plan: the system appends the payment of last month's GST when one is due",
  fixed_assets_depreciation: 'buying equipment, furniture or computers (purchase nature "asset") and a depreciation event on an asset ledger with a balance',
  tds_on_receipt: 'a sale with nature "service" to a corporate customer, later paid net of TDS (a receipt settling that invoice with "tds_withheld" set: "194J" for professional or consultancy work, "194C" for contract or installation work), plus an ordinary receipt paid in full',
  rcm_and_late_fee: 'a legal bill from an advocate or law firm, or a goods transport agency bill (the system books the reverse charge itself), and a payment with party null and ledger "GST Late Fee and Interest" on a delayed GST payment',
};

function rupees(value: number): string {
  return `Rs ${Math.round(value).toLocaleString('en-IN')}`;
}

function openItemsBlock(items: OpenItem[]): string {
  if (items.length === 0) return '- none: every earlier bill is settled and no advance is open';
  return items
    .map((item) => `- ${item.party} (${item.side}): ${item.kind === 'advance' ? `advance ${item.ref}` : `bill ${item.ref}`}, ${rupees(item.open)} open`)
    .join('\n');
}

function buildSystemPrompt(params: BatchPlanParams): string {
  const concepts = [...new Set([params.targetConcept, ...params.strengthConcepts, ...params.weaknessConcepts])];
  const stories = concepts.map((concept) => `- ${concept}: ${CONCEPT_STORIES[concept] ?? 'ordinary trading activity'}`).join('\n');
  const days =
    params.postingDays === 'any'
      ? 'any day of the month; spread the events across the month'
      : `ONLY these days of the month: ${params.postingDays.join(', ')} (Tally Educational Mode saves no other date)`;
  const composition = params.escalationActive
    ? `ESCALATION: the learner keeps failing "${params.targetConcept}". Make at least half the events clean, unambiguous reps of that concept; the rest ordinary trading.`
    : `COMPOSITION (checked in code): at least 2 sales and 2 purchases; at least 4 events that exercise the strength concepts (${params.strengthConcepts.join(', ') || 'none yet: use the target instead'}) and at least 4 that exercise the weakness concepts (${params.weaknessConcepts.join(', ') || params.targetConcept}). A sale or purchase can serve either side.`;

  return `You plan next month's business activity for ${params.companyName}, a GST-registered trading company in Karnataka (state code 29) whose books a trainee posts in Tally. You write WHAT HAPPENED commercially: who, on which day, what was supplied at what rate, which bills a payment settles. You never write ledger entries, GST heads or amounts, TDS, or bill references: the system computes every figure from the books below and from each party's fixed state.

Month: ${params.monthLabel}. Difficulty: ${params.difficultyLevel}.
Primary target concept: ${params.targetConcept}.
${composition}

What each concept means for the story:
${stories}

Recently strong areas (open the scenario by naming what it builds on, then the target; address the learner as "you"): ${params.recentStrengthDescriptions.join('; ') || 'none yet'}.

EVENT MENU (checked in code):
${describeMenu(params.menu)}
- Days allowed: ${days}. "day" is the day of ${params.monthLabel}.
- EVERY event carries EVERY field of the schema; a field that does not apply to the event's type is null (or [] for "lines" and "bills", false for "new_party"). Fields by type:
  - sale: party (the customer; for a counter sale use "Cash" with settlement "cash"), nature ("goods", or "service" when the company bills a service such as consultancy or installation), lines, gst_rate, doc_number (our invoice number), settlement ("credit" | "cash" | "adjust_advance"), adjust_advance_ref (only with "adjust_advance").
  - purchase: party (the vendor), nature ("goods" | "service" | "expense" | "asset"), ledger (null for goods), lines, gst_rate (null only for an exempt bill), doc_number (the vendor's bill number), settlement ("credit" | "adjust_advance"), adjust_advance_ref.
  - receipt: party (the customer), instrument ("bank" | "cash"), settlement_mode, bills, amount, why, tds_withheld.
  - payment to a party: party (the payee), instrument, settlement_mode, bills, amount, why. Direct expense payment: party null, ledger (the expense ledger), amount, instrument.
  - contra: direction, amount. depreciation: ledger (the asset ledger), months, annual_rate_percent.
  - credit_note: party (the customer), bills (exactly the one invoice it is against), lines, gst_rate, doc_number (the new note number). debit_note: the same with the vendor and their bill.
- settlement_mode "full": "bills" lists every bill settled and "amount" is null (the books know the balance). "part": "bills" holds the one bill and "amount" the payment. "advance" and "on_account": "bills" is [] and "amount" is the money; "on_account" also needs "why".
- A sale's "doc_number" is our invoice number (INV-...); a purchase's is the vendor's bill number. Every number must be new (see USED NUMBERS) and must not contain a date.
- "lines" carry quantity and a taxable rate per unit; GST is added by the system at "gst_rate", a slab in force.
- A purchase of nature "goods" posts to Purchases; "service" or "expense" names the expense ledger in "ledger" (e.g. "Legal & Professional Charges", "Rent", "Advertisement & Marketing"); "asset" names the asset ledger (e.g. "Office Equipment").
- A receipt or payment settles what the books hold: mode "full" names open bills of that party (the amount is their balance), "part" names one bill and an amount below its balance, "advance" is money before any bill, "on_account" only when no bill can be identified.
- A payment with no party is a direct expense: give "ledger" and "amount".
- PARTIES: use a name from PARTIES exactly as written. Never respell an existing party (no "M/s", "Pvt Ltd", "LLP", "& Co" variants). A genuinely new party needs new_party true and a plain trading name that does not start with "Cash" and does not contain Bank, HDFC, GST or TDS.
- LEDGERS: an expense or asset ledger is a plain ledger name, never a party, a cash or bank ledger, or a GST/TDS ledger. Name the expense ledger after what was bought, so a fee for legal, audit, consultancy, rent, repairs, advertising, freight or commission work is visibly that ("Legal & Professional Charges", "Audit Fees", "Rent", "Repairs & Maintenance", "Advertisement & Marketing", "Freight & Delivery Charges", "Commission"). Goods lines must describe goods, not services.
- DOCUMENT NUMBERS: one plain number in capitals with a serial, like INV-3012, MS/1001 or CN-07. No spaces, brackets, commas or dates, and never starting with ADV (the system numbers advances).
- LINES: describe the item in plain words. No amounts, percentages, dates or product codes in a description. Choose quantities and rates so every figure, GST included, is a whole rupee (for example a taxable value that is a multiple of 100).
- A credit_note or debit_note uses the same GST slab as the bill it is against.
- Depreciation is one month at a time: "months" is 1, on a fixed asset ledger with a balance, at an annual rate of 40 or below.
- "tds_withheld" is allowed only on a receipt that settles invoices raised with nature "service".
- Events on the same day are posted in "seq" order: give a receipt, payment or note a higher seq than the bill it settles.
- Keep cash and the bank positive at every step: cash withdrawals and deposits within what is held, payments within the bank balance on their day. Receipts dated later do not fund earlier payments.

PARTIES (each has ONE fixed state; a new party may be introduced with new_party true):
${params.parties.map((party) => `- ${party.name}: ${party.state}${party.role === 'unknown' ? '' : ` (${party.role})`}`).join('\n') || '- none yet'}

OPEN ITEMS in the books entering this month:
${openItemsBlock(params.openItems)}

POSITION entering this month: Cash ${rupees(params.cash)}; ${params.bankAccount} ${rupees(params.bank)}.

USED NUMBERS (never reuse; INV-18 and INV-018 are the same number): ${params.usedDocumentNumbers.slice(-150).join(', ') || 'none'}

EXPENSE, INCOME AND ASSET LEDGERS the company already uses (reuse names exactly where they fit): ${params.ledgerNames.join(', ') || 'none'}

TDS EXPOSURE this financial year (the system deducts TDS when a bill or the running total crosses the threshold):
${params.tdsExposure.map((row) => `- ${row.payee}, ${row.section}: ${rupees(row.paidSoFar)} so far`).join('\n') || '- none'}
${taxRulesSummaryFor(params.month)}

${params.documentsMode ? 'DOCUMENTS MODE: the learner works from paperwork; keep the story to events that produce a document (invoices, bills, bank movements) plus at most two month-end journals.' : ''}

"scenario": two or three sentences of story. No amounts, percentages, figures, bill numbers or dashes, and no mention of a tax treatment (TDS, CGST, SGST, IGST, reverse charge): the learner works those out.

Respond only with JSON matching the schema.`;
}

export function buildBatchPlanPrompt(params: BatchPlanParams): { messages: ChatMessage[]; jsonSchema: { name: string; schema: Record<string, unknown> } } {
  return {
    messages: [
      { role: 'system', content: buildSystemPrompt(params) },
      { role: 'user', content: `Plan ${params.monthLabel} for ${params.companyName}.` },
    ],
    jsonSchema: { name: 'batch_plan', schema: BATCH_PLAN_JSON_SCHEMA as unknown as Record<string, unknown> },
  };
}

export function buildBatchPlanRetryPrompt(
  params: BatchPlanParams,
  violations: string[],
): { messages: ChatMessage[]; jsonSchema: { name: string; schema: Record<string, unknown> } } {
  const base = buildBatchPlanPrompt(params);
  return {
    ...base,
    messages: [
      ...base.messages,
      {
        role: 'user',
        content: `Your previous plan was rejected by the books. Fix every point below and respond with a complete new plan:\n${violations.map((violation) => `- ${violation}`).join('\n')}`,
      },
    ],
  };
}
