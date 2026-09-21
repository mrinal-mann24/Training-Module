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
  customer_advance: 'a customer paying before you invoice (settlement mode "advance"), then an invoice that adjusts that advance (settlement "adjust_advance")',
  supplier_advance: 'paying a vendor before their bill (settlement mode "advance"), then the bill that adjusts it (settlement "adjust_advance")',
  on_account_reference: 'a receipt or payment that no bill can be identified for (settlement mode "on_account", with the reason)',
  multi_bill_settlement: 'one receipt or payment clearing two or three open bills of the same party (settlement mode "full" naming each)',
  gst_set_off: 'enough GST sales and purchases in the month for a set-off to matter; the system appends the set-off itself',
  gst_payment: "nothing to plan: the system appends the payment of last month's GST when one is due",
  fixed_assets_depreciation: 'buying equipment, furniture or computers (purchase nature "asset") and a depreciation event on an asset ledger with a balance',
  tds_on_receipt: 'a corporate customer paying an invoice for services or contract work net of TDS (receipt with "tds_withheld" set), plus an ordinary receipt paid in full',
  rcm_and_late_fee: 'a legal bill from an advocate or law firm, or a goods transport agency bill (the system books the reverse charge itself), and a payment with no payee for the expense ledger "GST Late Fee and Interest" on a delayed GST payment',
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
- A sale's "doc_number" is our invoice number (INV-...); a purchase's is the vendor's bill number. Every number must be new (see USED NUMBERS) and must not contain a date.
- "lines" carry quantity and a taxable rate per unit; GST is added by the system at "gst_rate", a slab in force.
- A purchase of nature "goods" posts to Purchases; "service" or "expense" names the expense ledger in "ledger" (e.g. "Legal & Professional Charges", "Rent", "Advertisement & Marketing"); "asset" names the asset ledger (e.g. "Office Equipment").
- A receipt or payment settles what the books hold: mode "full" names open bills of that party (the amount is their balance), "part" names one bill and an amount below its balance, "advance" is money before any bill, "on_account" only when no bill can be identified.
- A payment with no payee is a direct expense: give "expense_ledger" and "amount".
- Keep cash and the bank positive at every step: cash withdrawals and deposits within what is held, payments within the bank balance on their day. Receipts dated later do not fund earlier payments.

PARTIES (each has ONE fixed state; a new party may be introduced with new_party true):
${params.parties.map((party) => `- ${party.name}: ${party.state}${party.role === 'unknown' ? '' : ` (${party.role})`}`).join('\n') || '- none yet'}

OPEN ITEMS in the books entering this month:
${openItemsBlock(params.openItems)}

POSITION entering this month: Cash ${rupees(params.cash)}; ${params.bankAccount} ${rupees(params.bank)}.

USED NUMBERS (never reuse; INV-18 and INV-018 are the same number): ${params.usedDocumentNumbers.slice(-150).join(', ') || 'none'}

LEDGERS the company already uses (reuse names exactly where they fit): ${params.ledgerNames.join(', ') || 'none'}

TDS EXPOSURE this financial year (the system deducts TDS when a bill or the running total crosses the threshold):
${params.tdsExposure.map((row) => `- ${row.payee}, ${row.section}: ${rupees(row.paidSoFar)} so far`).join('\n') || '- none'}
${taxRulesSummaryFor(params.month)}

${params.documentsMode ? 'DOCUMENTS MODE: the learner works from paperwork; keep the story to events that produce a document (invoices, bills, bank movements) plus at most two month-end journals.' : ''}

"scenario": two or three sentences of story with NO rupee figures (the system prints the opening position). Never use an em dash.

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
