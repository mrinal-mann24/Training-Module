import type { ChatMessage } from '@/lib/llm/client';
import { CONCEPT_TAGS, type ConceptTag, type ExerciseDifficultyLevel } from '@/lib/schemas/exercise';
import type { CompanyLedgerRegistryEntry, CompanyTransactionLogEntry } from '@/lib/db/queries/company';
import type { LicenseMode } from '@/lib/schemas/onboarding';
import { EXERCISE_JSON_SCHEMA } from './exercise-json-schema';

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
};

function buildCompanyContextBlock(params: AdaptiveExerciseParams): string {
  if (params.companyLedgerRegistry.length === 0 && params.recentCompanyTransactionLog.length === 0) {
    return 'This is the learner\'s first adaptive exercise — no ledgers or transactions exist yet in their company. Introduce new, realistic ledger/party names freely.';
  }

  const ledgerLines = params.companyLedgerRegistry
    .map((entry) => `- ${entry.ledger_name} (${entry.ledger_type})`)
    .join('\n');

  const transactionLines = params.recentCompanyTransactionLog
    .map((entry) => `- ${JSON.stringify(entry.voucher_summary)}`)
    .join('\n');

  return `COMPANY CONTINUITY IS MANDATORY. The learner works in ONE single persistent
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
exercise at this difficulty level, not a harder one. Escalation OVERRIDES the
batch composition rules: ignore the 10-12 count and the 50/50 split, produce
2 to 4 focused transactions on the primary target concept only.`
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
- Then the transactions as a numbered list, each with a date, explicit parties with
  their STATE where GST matters, explicit amounts (base plus GST stated separately
  where applicable), and any bill/invoice numbers — concrete and postable, never
  vague ("some goods", "a customer").
- Close the scenario with a short deliverables line: post everything, export ONE
  Tally Day Book (Detailed, XML) plus the Trial Balance, and a reminder of the
  narration standard (bank reference verbatim PLUS party name on every payment and
  receipt).

Primary target concept: "${params.targetConceptTag}" (from the fixed vocabulary: ${CONCEPT_TAGS.join(', ')}).
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
- Before finalizing, COUNT your own transactions by concept_tags: if fewer
  than 4 carry a strength concept, or fewer than 4 carry a weakness concept,
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

Ledgers and parties: use ONLY accounts that exist in the company registry
below, or genuinely new realistic parties introduced by this batch's own
transactions. Never reference a vague holding account that isn't a real Tally
ledger ("Wallet", "Money Account") — cash movements go through the company's
actual Cash and bank ledgers. Spread the transactions across DIFFERENT dates
in the month (a real batch isn't all posted on one day).

Dates: every transaction is dated in 2026, continuing the company's timeline —
use the month FOLLOWING the latest transaction visible in the company context
below (if none is visible, use recent 2026 dates). The learner's books begin
01-Apr-2026: a voucher dated before that, or in any other year, is REJECTED by
the submission gate outright, so a wrong year breaks the whole batch. Amounts
are in Indian Rupees.${
    params.licenseMode === 'educational'
      ? `

EDUCATIONAL MODE DATE RULE (hard requirement): this learner's Tally
Educational Mode only saves vouchers dated the 1st, 2nd, or LAST day of a
month. EVERY transaction in this batch must be dated on one of those three
days — spread the batch across those allowed days, and across two
consecutive months where the timeline permits, instead of across arbitrary
dates. Any other day of the month makes the voucher unpostable for this
learner.`
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
actually fits the transaction (a vendor purchase/bill gets vendor_invoice; a
bank-recorded receipt or payment gets bank_statement). Otherwise set
requires_source_document to false and source_document_type to null. Not every
transaction needs one — use judgment, don't force it onto every entry.

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
