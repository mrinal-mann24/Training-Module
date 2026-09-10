import type { ChatMessage } from '@/lib/llm/client';
import { ACTIVE_CONCEPT_TAGS, type ConceptTag, type ExerciseDifficultyLevel } from '@/lib/schemas/exercise';
import type { CompanyLedgerRegistryEntry, CompanyTransactionLogEntry, OpenBill, PartyTaxClass } from '@/lib/db/queries/company';
import type { LicenseMode } from '@/lib/schemas/onboarding';
import { EXERCISE_JSON_SCHEMA } from './exercise-json-schema';
import { BOOKS_BEGIN_LABEL, BOOKS_BEGIN_YEAR } from '@/lib/tutor/timeline';

export type AdaptiveExerciseParams = {
  targetConceptTag: ConceptTag;
  // Phase 2 (spec 14): the batch's 50/50 composition plan. Step-up
  // transactions raise complexity on the strength concepts; reinforcement
  // transactions give scaffolded reps on the weakness concepts. Both empty in
  // escalation mode (which deliberately narrows to one concept).
  batchStrengthConcepts: ConceptTag[];
  batchWeaknessConcepts: ConceptTag[];
  // Plain-language names of concepts the learner has recently shown strength
  // in (Phase 1): the batch intro names what it builds on, pilot-style.
  recentStrengthDescriptions: string[];
  difficultyLevel: ExerciseDifficultyLevel;
  // Phase 3 (spec 15): Tally Educational Mode only saves vouchers dated the
  // 1st, 2nd, or last day of a month — generated batches for educational
  // learners must respect that or every voucher is unpostable.
  licenseMode: LicenseMode;
  escalationActive: boolean;
  companyLedgerRegistry: CompanyLedgerRegistryEntry[];
  recentCompanyTransactionLog: CompanyTransactionLogEntry[];
  // Month-per-module (2026-09-01): the calendar month this batch lives in
  // (e.g. "May 2026"), computed in code from the learner's module number —
  // module 1 is the diagnostic pack's April 2026, each module after
  // advances one month. The LLM never chooses the month itself.
  exerciseMonthLabel: string;
  // The learner's single persistent company, pinned by NAME (2026-09-01,
  // user's 5-point batch review #5) — read from the company log's pack
  // assignment row rather than inferred from the ledger list, so it can
  // never drift as the log's recent slice rolls forward.
  companyName: string;
  // The company's Cash and Bank balances entering this batch, netted from
  // every prior answer key (2026-09-02): without them the model invented
  // cash movements the learner could not possibly post, e.g. a ₹45,000 cash
  // deposit against ₹19,900 of cash on hand.
  cashPosition: { cash: number; bank: number };
  // Every bill still open in the books, derived from the answer keys
  // (2026-09-03): settlements may only reference these or bills raised in
  // the same batch — the model otherwise invents bill numbers.
  openBills: OpenBill[];
  // How each known party has been taxed so far (2026-09-03): a party's
  // state never changes, so its GST treatment cannot either.
  partyTaxClasses: Map<string, PartyTaxClass>;
  // Documents mode (2026-09-09): every sale, purchase and bank movement is
  // document-backed; journals stay fully written (they are delivered as a
  // month-end notes sheet by code). The code overrides whatever the model
  // decides per transaction, so this only steers the text it writes.
  documentsMode?: boolean;
};

// House practice per concept, from the Karbon rulebook (2026-09-10): the
// briefs for every concept in the batch are pasted into the prompt so the
// model writes the topic the way the house books it. The set-off and the
// GST payment are appended by code (month-end-journals.ts), never written
// by the model.
export const CONCEPT_BRIEFS: Record<ConceptTag, string> = {
  sales_voucher_basics:
    'Credit sale: Sales voucher, Dr customer (total, New Ref invoice number), Cr Sales (base), Cr Output GST per the customer state. Cash counter sale: Dr Cash instead of a customer.',
  purchase_voucher_basics:
    'Purchase or expense bill: Purchase voucher, Dr Purchases or the expense ledger (base), Dr Input GST, Cr vendor (total, New Ref bill number); TDS at booking where the section applies.',
  payment_voucher_basics:
    'Payment from the bank: Dr party or expense, Cr bank, Against Ref the bill being paid; the narration carries the bank reference.',
  receipt_voucher_basics: 'Receipt into the bank: Dr bank, Cr customer, Against Ref the invoice being settled.',
  contra_voucher_basics: 'Cash to bank or bank to cash only, sized to the balances actually held.',
  journal_voucher_basics:
    'Month-end adjustments: accruals to Outstanding Expenses, prepaid transfers, depreciation, and corrections by a reversal entry plus a fresh entry (never by editing history).',
  gst_classification:
    'Intra-state CGST plus SGST at half the rate each, inter-state IGST at the full rate, decided by the party state; Input on purchases, Output on sales; every GST figure is base times rate exactly.',
  tds_classification:
    'TDS at booking on the taxable base, never the GST-inclusive total: 194J professional 10%, 194C contractor 1%/2% (30,000 single or 1,00,000 aggregate), 194I rent 10% (2,40,000 aggregate), 194H commission 5%; only once the year threshold is crossed for that payee; vendor credited net, TDS Payable per section.',
  bill_by_bill_referencing:
    'Every party leg carries a reference: New Ref when a bill is raised, Against Ref (each bill named) when it is settled, Advance for money before a bill, On Account only when no bill can be identified.',
  narration_discipline: 'Retired: narration is not scored beyond the bank reference on bank vouchers.',
  trial_balance_tie_out: 'Nothing separate to write: every posting must leave the books consistent.',
  customer_advance:
    'Advance received before any invoice (rulebook 9): Receipt Dr bank, Cr customer with a NEW reference of type Advance (bill_reference like "ADV-C01 (Advance)"). GOODS: no GST on the advance. SERVICE: the receipt credits the customer for the base and Output CGST on Advance plus Output SGST on Advance (or Output IGST on Advance) for the GST portion. When the invoice is raised, the Sales voucher allocates Against Ref ADV-C01 for the advance and New Ref for the balance; for a service advance add a journal Dr Output CGST on Advance / Dr Output SGST on Advance, Cr Output CGST / Cr Output SGST for the GST now recognised on the invoice. Include the advance and the invoice that adjusts it.',
  supplier_advance:
    'Advance paid to a supplier before the bill (rulebook 10): Payment Dr supplier with a NEW Advance reference (bill_reference like "ADV-S01 (Advance)"), Cr bank; no Input GST at payment. When the bill arrives, the Purchase voucher allocates Against Ref ADV-S01 for the advance and New Ref for the balance. With TDS on a service advance: Dr supplier (gross, Advance ref), Cr TDS Payable of the section, Cr bank (net); the later bill deducts TDS only on the remaining base.',
  on_account_reference:
    'A receipt or payment that cannot be tied to a specific bill (rulebook 4): the party allocation is On Account, bill_reference "On Account", and the text says why no bill can be identified. Never for a bill that exists.',
  multi_bill_settlement:
    'One payment or receipt across several bills (rulebook 6.4/7.4): one bank leg; the party allocation names EACH bill it clears with its amount, bill_reference like "MS-101, MS-102". A part payment allocates Against Ref for the amount paid and the balance stays open.',
  tds_on_receipt:
    'The customer pays net of TDS (rulebook 7.2): Receipt Dr bank (net), Dr TDS Receivable of the section (the TDS the customer withheld: 10% of the base for professional services under 194J, 2% under 194C), Cr customer (gross, Against Ref the invoice); tds_section and tds_base on the TDS Receivable leg. Also include a receipt paid in full where no TDS applies.',
  gst_set_off:
    'Do NOT write the set-off: the system appends the month-end GST set-off journal with figures taken from the ledger. Give the month enough GST sales and purchases for a set-off to matter.',
  gst_payment:
    'Do NOT write the payment: the system appends the payment of the previous month GST liability from the bank when one exists.',
  rcm_and_late_fee:
    'Reverse charge (rulebook 13): a service from an unregistered supplier or a goods transport agency: Purchase Dr expense / Cr vendor (no vendor GST), plus a journal Dr Input CGST RCM and Dr Input SGST RCM / Cr Output CGST RCM and Cr Output SGST RCM for the tax the company pays itself. A late fee or interest on a delayed GST payment: Payment Dr GST Late Fee and Interest (indirect expense) / Cr bank.',
  fixed_assets_depreciation:
    'A capital purchase goes to the asset ledger (Office Equipment, Furniture, Computers), never Purchases, with Input GST claimed in full in the month of purchase; depreciation at year end by journal Dr Depreciation / Cr the asset ledger at the stated rate.',
};

function buildConceptBriefsBlock(params: AdaptiveExerciseParams): string {
  const tags = [...new Set([params.targetConceptTag, ...params.batchStrengthConcepts, ...params.batchWeaknessConcepts])];
  return `CONCEPT BRIEFS (house practice from the rulebook; follow them exactly for the concepts in this batch):
${tags.map((tag) => `- ${tag}: ${CONCEPT_BRIEFS[tag]}`).join('\n')}
`;
}

function buildPartyStatesBlock(classes: Map<string, PartyTaxClass>): string {
  if (classes.size === 0) return '';
  const lines = [...classes.entries()]
    .map(([party, cls]) => `- ${party}: ${cls === 'intra' ? 'Karnataka (intra-state: CGST + SGST)' : 'outside Karnataka (inter-state: IGST)'}`)
    .join('\n');
  return `PARTY STATES (hard requirement): these parties already exist in the books with
the GST treatment below. A party's state never changes, so every new sale
to or purchase from them MUST use the same treatment; do not relocate a
party to another state.
${lines}

`;
}

function buildOpenBillsBlock(openBills: OpenBill[]): string {
  const lines =
    openBills.length === 0
      ? '- (none: every earlier bill is fully settled)'
      : openBills
          .map((bill) => `- ${bill.party} (${bill.side}): ${bill.ref} — Rs ${Math.round(Math.abs(bill.open)).toLocaleString('en-IN')} outstanding`)
          .join('\n');
  return `OPEN BILLS (hard requirement): these are the ONLY bills currently open in the
company's books, with the balance outstanding on each:
${lines}
A receipt or payment posted "against" a bill MUST name one of these bills, for
that same party, and its amount can never exceed that bill's balance. Say
"full settlement" only when the amount equals the balance exactly; otherwise
call it a part payment. A bill raised earlier in THIS batch may also be
settled later in the batch. Any other receipt or payment is an advance:
record it as a New Ref and say so in its text. Never invent a bill number
that is not listed here or raised in this batch.`;
}

function buildCompanyContextBlock(params: AdaptiveExerciseParams): string {
  const companyLine = `THE COMPANY IS: ${params.companyName} (home state Karnataka, GST state code 29).
Every batch is set in this exact company — by name — for the learner's entire
journey. Never rename it, never move it to another state.`;

  if (params.companyLedgerRegistry.length === 0 && params.recentCompanyTransactionLog.length === 0) {
    return `${companyLine}

This is the learner's first adaptive exercise — no ledgers or transactions exist yet in their company. Introduce new, realistic ledger/party names freely (within this company).`;
  }

  const ledgerLines = params.companyLedgerRegistry
    .map((entry) => `- ${entry.ledger_name} (${entry.ledger_type})`)
    .join('\n');

  const transactionLines = params.recentCompanyTransactionLog
    .map((entry) => `- ${JSON.stringify(entry.voucher_summary)}`)
    .join('\n');

  return `${companyLine}

COMPANY CONTINUITY IS MANDATORY. The learner works in ONE single persistent
Tally company for their entire journey — the SAME company name, state, bank
account, and parties as the transactions below. NEVER invent a different
company, a different home state, or a generic "Savings Account / Current
Account" setup that ignores this context: a batch set in the wrong company is
unusable, because the learner posts into their existing books.

Below is what already exists in that company. Either reuse an existing
ledger/party name where realistic (continuity — a repeat customer, an ongoing
vendor relationship) or introduce a genuinely new one. NEVER reintroduce a name
already in the registry with different characteristics (e.g. a second "Parekh
Integrated Services Pvt Ltd" with a different GSTIN, or an opening balance that
contradicts a ledger already established) — that would be an internal
contradiction in the same company's books.

Ledgers already in this company:
${ledgerLines || '(none yet)'}

Recent transactions already posted in this company:
${transactionLines || '(none yet)'}`;
}

function buildSystemPrompt(params: AdaptiveExerciseParams): string {
  const companyContext = buildCompanyContextBlock(params);

  const escalationInstruction = params.escalationActive
    ? `ESCALATION MODE IS ACTIVE for this concept: the learner has failed it repeatedly
recently. Slow the pacing down — use a single, isolated, unambiguous transaction
for this concept rather than mixing it with distractors, and make the scenario
prose more explicit about what's being asked, with more scaffolding context than
usual (without stating the answer). This is more hand-holding than a normal
exercise at this difficulty level, not a harder one. Escalation narrows the batch
rather than shrinking it (2026-09-10: batches of 3 or 4 entries were the
interns' loudest complaint): keep 8 to 10 transactions, at least half of them
clean, unambiguous reps of the primary target concept, the rest ordinary
trading activity; the 50/50 strength/weakness split does not apply.`
    : `Escalation is not active for this concept — generate a normal exercise at the
stated difficulty level, no extra scaffolding needed.`;

  return `You are generating the next practice batch for a B.Com fresher learning Tally
bookkeeping, personalized to their current mastery state — this is not the fixed
diagnostic template, it targets whatever they're actually weak on.

Write it in the house "batch" style — the way a senior reviewer hands a trainee
their next set (this is the exact format proven in the pilot programme):
- Open the scenario by naming what it builds on, then what it targets, in the
  pilot programme's register: "Batch: same company, continuing. Your invoices
  and TDS were strong, so this batch works on the bank side." Use the
  learner's recently strong areas listed below when any are given; when none
  are, open with the frame and the target alone. Address the learner directly
  ("you"), never "the learner".
- The transactions themselves go ONLY in the structured "transactions" array: the
  app renders that array as the numbered list directly under the scenario text,
  so the scenario text must NOT repeat the numbered transactions (a learner saw
  the same 12 items twice). Each array item has a date, explicit parties with
  their STATE where GST matters, explicit amounts (base plus GST stated separately
  where applicable), and any bill/invoice numbers — concrete and postable, never
  vague ("some goods", "a customer").
- Close the scenario with a short deliverables line: post everything, export ONE
  Tally Day Book (Detailed, XML) plus the Trial Balance, and a reminder of the
  narration standard (bank reference verbatim PLUS party name on every payment and
  receipt).

Primary target concept: "${params.targetConceptTag}" (from the fixed vocabulary: ${ACTIVE_CONCEPT_TAGS.join(', ')}).
The primary target must genuinely appear in the batch; a scenario that never
exercises it is wrong.

BATCH COMPOSITION (unless escalation mode below says otherwise) — THIS IS A HARD
REQUIREMENT, NOT A SUGGESTION. A batch that is entirely one concept (e.g. every
transaction is a contra/cash-bank transfer) is WRONG even if it hits 10-12
transactions and even if it targets the right concept overall:
- The batch has 10 to 12 numbered transactions. Fewer than 10 is too shallow;
  simple cash-to-bank and bank-to-cash movements alone are not a batch, no
  matter how many of them there are.
- AT LEAST 4 transactions are STEP-UPS: they exercise the strength concepts
  listed below (a DIFFERENT concept from the weakness/target side) at one
  difficulty level ABOVE the stated level, each layering in one genuine new
  twist or trap (a partial payment, a threshold edge, a place-of-supply
  switch) rather than repeating what was already easy.
- AT LEAST 4 transactions are REINFORCEMENT: they exercise the weakness
  concepts listed below at the stated level, cleaner and more scaffolded,
  giving honest reps on exactly what went wrong.
- TRADING MIX (hard requirement): the learner's company is a GST-registered
  TRADING business, so every batch includes at least 2 Sales transactions and
  at least 2 Purchase transactions with realistic GST treatment (intra-state
  CGST+SGST or inter-state IGST per the party's state), whatever the target
  concept is. A bank-side target is practiced ALONGSIDE the month's trading
  activity, never instead of it — a month of only cash/bank movements is
  unrealistic and invalid. Trading transactions may (and usually should)
  double as the step-up or reinforcement reps via their concept_tags.
- Before finalizing, COUNT your own transactions by concept_tags AND by
  voucher type: if fewer than 4 carry a strength concept, fewer than 4 carry
  a weakness concept, fewer than 2 are Sales, or fewer than 2 are Purchases,
  the batch is invalid — revise it before responding.
- Every transaction's answer key concept_tags name the concept(s) that
  transaction serves, so scoring can attribute each rep to its side.
Strength concepts to step up: ${
    params.batchStrengthConcepts.length > 0 ? params.batchStrengthConcepts.join(', ') : '(none yet: fill the step-up half with the primary target at the stated level instead)'
  }
Weakness concepts to reinforce: ${params.batchWeaknessConcepts.length > 0 ? params.batchWeaknessConcepts.join(', ') : params.targetConceptTag}

Recently strong areas (for the opening line): ${
    params.recentStrengthDescriptions.length > 0 ? params.recentStrengthDescriptions.join('; ') : '(none yet)'
  }

Difficulty level: ${params.difficultyLevel}.

${buildConceptBriefsBlock(params)}

ANSWER KEY SHAPE (hard requirement): answer_key.entries holds EVERY ledger leg
of every transaction's Tally voucher, one entry per leg, all sharing that
transaction's sequence — never a single summary entry per transaction. At
least one Dr leg AND at least one Cr leg per transaction, and the debits must
equal the credits. Examples of the required shape:
- Sale on credit with IGST: Dr customer (total) / Cr Sales (base) / Cr Output IGST.
- Purchase with CGST+SGST: Dr Purchases (base) / Dr Input CGST / Dr Input SGST / Cr supplier (total).
- Purchase with TDS: Dr expense (gross) / Cr TDS Payable / Cr vendor (net).
- Payment: Dr party or expense / Cr the bank. Receipt: Dr the bank / Cr customer.
- Contra: Dr the bank / Cr Cash, or the reverse.
- Customer advance (goods): Receipt Dr the bank / Cr customer, bill_reference "ADV-C01 (Advance)".
- Customer advance (service): Receipt Dr the bank (total) / Cr customer (base, Advance ref) / Cr Output CGST on Advance / Cr Output SGST on Advance.
- Supplier advance: Payment Dr supplier (Advance ref "ADV-S01 (Advance)") / Cr the bank; with TDS: Dr supplier (gross) / Cr TDS Payable — u/s 194J / Cr the bank (net).
- Receipt net of TDS: Dr the bank (net) / Dr TDS Receivable — u/s 194J / Cr customer (gross, Against Ref the invoice).
- Multi-bill payment: Dr supplier (total, bill_reference "MS-101, MS-102") / Cr the bank.
- On Account receipt: Dr the bank / Cr customer, bill_reference "On Account".

MONTH-END GST (hard rule): never write a GST set-off journal or a GST payment
to the government yourself. When the batch calls for them, the system appends
both with figures taken from the ledger, dated inside the month.
GST and TDS are real ledger legs ("Output IGST", "Input CGST", "TDS Payable — u/s 194J"),
not just metadata; gst_head/tds_section on the tax leg say which head.

${buildPartyStatesBlock(params.partyTaxClasses)}${buildOpenBillsBlock(params.openBills)}

OPENING BALANCES (hard requirement): entering this batch the company holds
Rs ${Math.round(params.cashPosition.cash).toLocaleString('en-IN')} in Cash-in-Hand and
Rs ${Math.round(params.cashPosition.bank).toLocaleString('en-IN')} in the bank. Do NOT
quote these opening figures in the scenario prose: the system prints the
opening position itself, and any rupee figure you write in a sentence about
cash, the bank or the till is checked digit-for-digit against the real
position. You may say the till is overdrawn without stating the amount.${
    params.cashPosition.cash < 0
      ? `
THE TILL IS OVERDRAWN by Rs ${Math.abs(Math.round(params.cashPosition.cash)).toLocaleString('en-IN')}
(an earlier batch called for a deposit larger than the cash actually held).
Transaction 1 of THIS batch MUST therefore be a Contra withdrawal from the
bank to Cash of at least that shortfall plus a sensible working float
(round up to a clean figure), so the till is positive before anything else
happens. No other cash movement may precede it.`
      : ''
  }
Every transaction must be POSTABLE from that position: cash can never go
negative at any point in the batch, and the bank can never be overdrawn.
Cash deposits into the bank are limited by the cash actually on hand at that
moment (opening cash plus any cash the batch itself brings in first), and
cash withdrawals plus payments are limited by the running bank balance. Size
the cash movements to the position, not to round-sounding figures: with a
small cash balance, a realistic deposit is a few thousand rupees, not tens
of thousands. Walk your own transactions in order before responding and
confirm neither balance ever goes below zero.

Ledgers and parties: use ONLY accounts that exist in the company registry
below, or genuinely new realistic parties introduced by this batch's own
transactions. Never reference a vague holding account that isn't a real Tally
ledger ("Wallet", "Money Account") — cash movements go through the company's
actual Cash and bank ledgers. Spread the transactions across DIFFERENT dates
in the month (a real batch isn't all posted on one day).

Dates (HARD REQUIREMENT): EVERY transaction in this batch is dated inside
${params.exerciseMonthLabel} — no other month, no other year, ever. The
company's timeline advances exactly one month per module, computed by the
system, and a batch never mixes months. Write each date explicitly in every
transaction line (e.g. "On 01-${params.exerciseMonthLabel.slice(0, 3)}-${params.exerciseMonthLabel.slice(-4)}, ...").
The learner's books begin ${BOOKS_BEGIN_LABEL}: a voucher dated before that, or in any
other year, is REJECTED by the submission gate outright. Amounts are in
Indian Rupees.${
    params.licenseMode === 'educational'
      ? `

EDUCATIONAL MODE DATE RULE (hard requirement): this learner's Tally
Educational Mode only saves vouchers dated the 1st, 2nd, or LAST day of a
month. EVERY transaction in this batch must be dated on one of those three
days WITHIN ${params.exerciseMonthLabel} — multiple vouchers on the same
allowed day are fine and expected. Any other day of the month makes the
voucher unpostable for this learner.`
      : ''
  }

${escalationInstruction}

${companyContext}

Produce learner-facing scenario prose and transactions, plus the hidden answer key
for each transaction: correct account, Dr/Cr, amount, voucher type, and narration.
Set gst_head, gst_rate, tds_section, tds_rate, tds_base, and bill_reference to null
unless the transaction genuinely has that component — state null explicitly, never
omit the field. Tag each answer key entry's concept_tags with every concept tag
(from the fixed vocabulary above) it genuinely drills — usually one, occasionally
more for a transaction that legitimately combines concepts.

For each transaction, decide whether the learner should receive it as a source
document (a generated PDF vendor invoice/bill or bank statement) instead of a
plain-text description alone — this is the product's rising-realism progression, so
lean toward using one at this difficulty level when the transaction is genuinely the
kind of thing that would arrive as a real document (a vendor billing the business, or
an entry the learner would see on a bank statement). Set requires_source_document to
true and source_document_type to whichever of "vendor_invoice" or "bank_statement"
actually fits the transaction. HARD RULE: a Contra, Receipt, or Payment
transaction can ONLY ever be bank_statement (a bank transfer or settlement never
arrives as an invoice); vendor_invoice is reserved for a vendor actually billing
the business (a Purchase or expense bill). All bank_statement transactions in the
batch are delivered to the learner as lines of ONE combined statement, so flag
every genuinely bank-visible movement consistently. Otherwise set
requires_source_document to false and source_document_type to null. Not every
transaction needs one — use judgment, don't force it onto every entry.

DOCUMENT-BACKED TRANSACTION TEXT (hard requirement): when a transaction has
requires_source_document true, its numbered line is a short POINTER, not a
spelled-out entry — the learner must pull the figures from the document, like
real work. The pointer states the date, the party, and what happened, then
directs to the document: "On 05-May-${BOOKS_BEGIN_YEAR}, an invoice arrived from Signage
Advertising for marketing collaterals: post it from the attached invoice", or
"On 12-May-${BOOKS_BEGIN_YEAR}, a receipt from Delhi Bazaar landed in the bank: post it from
the bank statement". NEVER state the amount, the GST amount or rate, or the
tax split in a document-backed transaction's text — restating them makes the
document pointless. (The hidden answer key still carries the exact figures as
always.) Transactions WITHOUT a document keep full explicit details in the
text: date, parties with state, amounts with GST stated separately, bill
numbers.

${
    params.documentsMode
      ? `
DOCUMENTS MODE (overrides the "use judgment" rule above): this learner now
works from paperwork only. EVERY Sales transaction (a cash counter sale too)
has requires_source_document true with source_document_type "sales_invoice";
EVERY Purchase has "vendor_invoice"; EVERY Contra, Receipt and Payment has
"bank_statement". Write all of those lines as pointers with NO figures, as
described above; for a sale the pointer names the customer and the invoice
number, for a cash sale it just says a counter sale was made for cash. Journals,
debit notes and credit notes keep requires_source_document false and full
explicit details in their text; the system moves them onto a month-end notes
sheet for the learner. Keep the usual mix of the batch, including two or more
journal-type entries.
`
      : ''
  }
Never use an em dash anywhere in learner-facing text; use a colon, comma, or full stop.

Respond only with JSON matching the provided schema. The "variant" field should be "A".`;
}

export function buildAdaptivePrompt(params: AdaptiveExerciseParams): {
  messages: ChatMessage[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
} {
  return {
    messages: [
      { role: 'system', content: buildSystemPrompt(params) },
      { role: 'user', content: `Generate the adaptive exercise targeting "${params.targetConceptTag}" at ${params.difficultyLevel}.` },
    ],
    jsonSchema: {
      name: 'adaptive_exercise',
      schema: EXERCISE_JSON_SCHEMA,
    },
  };
}

export function buildAdaptiveRetryPrompt(
  params: AdaptiveExerciseParams,
  validationError: string,
): { messages: ChatMessage[]; jsonSchema: { name: string; schema: Record<string, unknown> } } {
  const base = buildAdaptivePrompt(params);
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
