import { getTracedStructuredCompletion, type TracedCompletionParams } from '@/lib/llm/tracing';
import {
  buildHintPrompt,
  buildHintRetryPrompt,
  summarizePackAnswerKey,
  type HintFact,
  type HintPromptContext,
} from '@/lib/llm/prompts/hint';
import { VIDEO_MODULES, videoModulesForConcept } from '@/lib/llm/grounding/video-modules';
import { HintModelOutputSchema, type Hint, type HintModelOutput } from '@/lib/schemas/hint';
import { CONCEPT_TAGS, isRetiredConcept, type AnswerKey, type AnswerKeyEntry, type ConceptTag } from '@/lib/schemas/exercise';
import type { LicenseMode } from '@/lib/schemas/onboarding';
import {
  EDUCATIONAL_DATE_RULE,
  EDUCATIONAL_DATE_TIP,
  LlmTimeoutError,
  containsPhrase,
  dashViolation,
  educationalDayViolations,
  gstHeadsIn,
  isEducational,
  isFailedAttemptError,
  numbersIn,
  referencesIn,
  replaceDashes,
  rulebookPointer,
  rulebookSourcesForConcept,
  tdsSectionsIn,
  withTimeout,
} from '@/lib/tutor/grounded-prose';

// A learner waits on this (the help button, and the correction round's pushed
// step). Two attempts of at most 45 seconds each, and a timeout goes straight
// to the fallback, so a stuck model costs the learner under a minute, never
// the client's multi-minute transient retries (2026-09-17).
export const HINT_TIMEOUT_MS = 45_000;
export const HINT_MAX_ATTEMPTS = 2;

// Hints phrase a fixed fact list; they have no use for creative sampling.
const HINT_TEMPERATURE = 0.2;

// A drill has a handful of transactions per concept; the cap only guards the
// prompt against an unusual key.
const MAX_KEY_FACTS = 8;
const MAX_RULE_FACT_CHARS = 3000;

export type HintDeps = {
  complete: (params: TracedCompletionParams) => Promise<unknown>;
  timeoutMs: number;
  maxAttempts: number;
};

// How each concept reads inside a sentence.
const CONCEPT_PHRASE: Record<ConceptTag, string> = {
  sales_voucher_basics: 'the sales vouchers',
  purchase_voucher_basics: 'the purchase vouchers',
  payment_voucher_basics: 'the payment vouchers',
  receipt_voucher_basics: 'the receipt vouchers',
  contra_voucher_basics: 'the contra entries',
  journal_voucher_basics: 'the journal vouchers',
  gst_classification: 'the GST treatment',
  tds_classification: 'the TDS treatment',
  bill_by_bill_referencing: 'the bill-by-bill references',
  narration_discipline: 'the narrations',
  trial_balance_tie_out: 'the Trial Balance tie-out',
  customer_advance: 'the customer advances',
  supplier_advance: 'the supplier advances',
  on_account_reference: 'the on-account references',
  multi_bill_settlement: 'settling several bills with one amount',
  tds_on_receipt: 'TDS deducted by a customer on a receipt',
  gst_set_off: 'the month-end GST set-off',
  gst_payment: 'the GST payment',
  rcm_and_late_fee: 'reverse charge and GST late fees',
  fixed_assets_depreciation: 'fixed assets and depreciation',
};

// Step 1's guiding question, one per concept, written here rather than by a
// model: concept-level only, no figures and no names.
const GUIDING_QUESTION: Record<ConceptTag, string> = {
  sales_voucher_basics: 'which ledger carries the customer, and which carries the income?',
  purchase_voucher_basics: 'is this a purchase of stock, an expense or an asset, and which ledger says so?',
  payment_voucher_basics: 'who is being paid, and is there an open bill this payment settles?',
  receipt_voucher_basics: 'who is paying, and which open invoice does this money clear?',
  contra_voucher_basics: 'is money only moving between cash and bank, with no party involved?',
  journal_voucher_basics: 'why does this entry need a journal rather than a payment, receipt, sales or purchase voucher?',
  gst_classification: 'is the supply within one state or across states, and what does that decide about the GST heads?',
  tds_classification: 'what is the nature of the payment, has it crossed the threshold, and is TDS worked on the taxable value or the gross?',
  bill_by_bill_referencing: 'is this a new bill, a settlement of an existing one, an advance or an on-account amount?',
  narration_discipline: 'would a reviewer reading only the narration know what happened and why?',
  trial_balance_tie_out: "does every ledger in your Trial Balance move by what this month's entries say it should?",
  customer_advance: 'has the customer paid before the invoice exists, and is it for goods or for services?',
  supplier_advance: "has money gone to the supplier before their bill arrived, and how will the bill adjust it later?",
  on_account_reference: 'does this amount belong to a specific bill yet, or does it sit on account until one is matched?',
  multi_bill_settlement: 'which open bills does this single amount clear, and how much goes against each?',
  tds_on_receipt: 'why did the customer pay less than the invoice, and where does the deducted part go?',
  gst_set_off: 'in what order is input credit used against the output tax at month end?',
  gst_payment: 'what is left payable after the set-off, and which ledger does the payment clear?',
  rcm_and_late_fee: 'who pays the GST when reverse charge applies, and can a late fee ever be claimed as credit?',
  fixed_assets_depreciation: 'does this spend last beyond the year, and how is its cost spread over time?',
};

// Registry modules for the rulebook-section concepts, which no module lists
// in its conceptTags. Titles still come from the registry, never from here.
const VIDEO_ID_FOR_CONCEPT: Partial<Record<ConceptTag, string>> = {
  customer_advance: 'customer-advance-goods',
  supplier_advance: 'supplier-advance',
  on_account_reference: 'receipts-payments-bill-by-bill',
  multi_bill_settlement: 'receipts-payments-bill-by-bill',
  tds_on_receipt: 'tds-at-booking',
  gst_set_off: 'journal-adjustments-gst-utilisation',
  gst_payment: 'journal-adjustments-gst-utilisation',
  rcm_and_late_fee: 'journal-adjustments-gst-utilisation',
};

function isConceptTag(tag: string | undefined): tag is ConceptTag {
  return tag !== undefined && (CONCEPT_TAGS as readonly string[]).includes(tag);
}

// The concept a step is about: the one scoring flagged when the step was
// pushed, otherwise the concept the most transactions in the key drill.
export function chooseHintConcept(context: Pick<HintPromptContext, 'focusConceptTag' | 'answerKey'>): ConceptTag {
  if (isConceptTag(context.focusConceptTag)) {
    return context.focusConceptTag;
  }
  const sequencesByConcept = new Map<ConceptTag, Set<number>>();
  for (const entry of context.answerKey.entries) {
    for (const tag of entry.concept_tags) {
      if (isRetiredConcept(tag)) continue;
      sequencesByConcept.set(tag, (sequencesByConcept.get(tag) ?? new Set()).add(entry.sequence));
    }
  }
  let best: ConceptTag = 'sales_voucher_basics';
  let bestCount = 0;
  for (const tag of CONCEPT_TAGS) {
    const count = sequencesByConcept.get(tag)?.size ?? 0;
    if (count > bestCount) {
      best = tag;
      bestCount = count;
    }
  }
  return best;
}

export function videoTitleForConcept(concept: ConceptTag): string | null {
  const candidates = videoModulesForConcept(concept).sort((a, b) => a.conceptTags.length - b.conceptTags.length);
  const video = candidates[0] ?? VIDEO_MODULES.find((entry) => entry.id === VIDEO_ID_FOR_CONCEPT[concept]);
  return video?.title ?? null;
}

// Step 1, composed in code (2026-09-17): the registry title verbatim and the
// concept's guiding question. It used to be a model call told "never invent
// a title", with nothing checking that it did not.
export function composeStepOne(concept: ConceptTag, licenseMode?: LicenseMode | null): string {
  const title = videoTitleForConcept(concept);
  const rule = rulebookSourcesForConcept(concept)[0];
  const pointer = title ? `Watch "${title}".` : rule ? `Read ${rulebookPointer(rule)}.` : 'Look back at the module notes for this concept.';
  const tip = isEducational(licenseMode) ? ` ${EDUCATIONAL_DATE_TIP}` : '';
  return `${pointer} As you do, ask yourself: ${GUIDING_QUESTION[concept]}${tip}`;
}

function rupees(amount: number): string {
  return `Rs ${Math.abs(amount).toLocaleString('en-IN')}`;
}

function describeKeyTransaction(sequence: number, legs: AnswerKeyEntry[], concept: ConceptTag): string {
  const billRef = legs.find((leg) => leg.bill_reference)?.bill_reference;
  const postings = legs.map((leg) => {
    const gst = leg.gst_head ? ` (GST head ${leg.gst_head}${leg.gst_rate !== null ? ` at ${leg.gst_rate}%` : ''})` : '';
    const tds = leg.tds_section
      ? ` (TDS section ${leg.tds_section}${leg.tds_rate !== null ? ` at ${leg.tds_rate}%` : ''}${leg.tds_base !== null ? ` on a base of ${rupees(leg.tds_base)}` : ''})`
      : '';
    return `${leg.dr_cr} ${leg.correct_account} ${rupees(leg.amount)}${gst}${tds}`;
  });
  const narration =
    concept === 'narration_discipline' ? legs.find((leg) => leg.narration)?.narration : null;
  return replaceDashes(
    `Transaction ${sequence}${billRef ? `, bill reference ${billRef}` : ''}: ${legs[0].voucher_type} voucher. ${postings.join('; ')}.${narration ? ` Narration: ${narration}.` : ''}`,
  );
}

// The closed fact list for steps 2 and 3. Pack mode builds no answer-key
// fact at all (see summarizePackAnswerKey's comment); a drill builds one K
// and one X fact per transaction of the concept.
export function buildHintFacts(context: HintPromptContext, concept: ConceptTag): HintFact[] {
  const facts: HintFact[] = rulebookSourcesForConcept(concept).map((source) => ({
    id: source.id,
    kind: 'rule',
    text: source.text.length > MAX_RULE_FACT_CHARS ? source.text.slice(0, MAX_RULE_FACT_CHARS) : source.text,
  }));
  if (isEducational(context.licenseMode)) {
    facts.push({ id: 'E1', kind: 'license', text: EDUCATIONAL_DATE_RULE });
  }
  if (context.packMode) {
    const areas = summarizePackAnswerKey(context.answerKey).concept_areas.map((area) => area.replace(/_/g, ' '));
    facts.push({ id: 'S1', kind: 'set', text: `This practice set covers these concept areas: ${areas.join(', ')}.` });
    return facts;
  }
  const legsBySequence = new Map<number, AnswerKeyEntry[]>();
  for (const entry of context.answerKey.entries) {
    if (entry.concept_tags.includes(concept)) {
      legsBySequence.set(entry.sequence, []);
    }
  }
  for (const entry of context.answerKey.entries) {
    legsBySequence.get(entry.sequence)?.push(entry);
  }
  const sequences = [...legsBySequence.keys()].sort((a, b) => a - b).slice(0, MAX_KEY_FACTS);
  for (const sequence of sequences) {
    const description = context.transactions.find((transaction) => transaction.sequence === sequence)?.description;
    if (description) {
      facts.push({ id: `X${sequence}`, kind: 'transaction', sequence, text: replaceDashes(`Transaction ${sequence}: ${description}`) });
    }
    facts.push({ id: `K${sequence}`, kind: 'key', sequence, text: describeKeyTransaction(sequence, legsBySequence.get(sequence) ?? [], concept) });
  }
  return facts;
}

// Ledger names distinctive enough to be an answer when they appear in prose:
// several words, or a digit, "@" or "&" in them. Single common words
// ("Sales", "Rent") read as ordinary English and are not policed by name.
export function distinctiveKeyNames(answerKey: AnswerKey): string[] {
  const names = new Set<string>();
  for (const entry of answerKey.entries) {
    for (const name of [entry.correct_account, ...(entry.account_aliases ?? [])]) {
      const trimmed = name.trim();
      if (/\s/.test(trimmed) || /[\d@&]/.test(trimmed)) names.add(trimmed);
    }
  }
  return [...names].sort((a, b) => b.length - a.length);
}

export type HintGroundingContext = {
  rung: 2 | 3;
  packMode: boolean;
  keyNames: readonly string[];
  licenseMode?: LicenseMode | null;
};

const TRANSACTION_REFERENCE = /\b(?:transactions?|entry|entries)\s+(\d+(?:\s*(?:,|and|&)\s*\d+)*)/gi;

// The hint contract, checked in code (2026-09-17). Returns every violation,
// phrased to hand back to the model; empty means grounded. The rules:
//  - at least one fact id, all of them listed;
//  - every figure, bill reference, key ledger/party name, GST head and TDS
//    section in the text occurs in the cited facts;
//  - step 2 and every pack-mode step name no key ledger at all, state no
//    figure that a K fact carries, and use a bill reference only from a
//    transaction description; "transaction N" must be a listed transaction;
//  - for Educational Mode learners every day of the month mentioned is the
//    1st, 2nd or 31st;
//  - no em dash or en dash.
export function checkHintGrounding(output: HintModelOutput, facts: HintFact[], context: HintGroundingContext): string[] {
  const violations: string[] = [];
  const text = output.hint_text;
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const citedFacts: HintFact[] = [];
  if (output.fact_ids.length === 0) {
    violations.push('The hint cites no fact ids. List the id of every fact it uses.');
  }
  for (const id of output.fact_ids) {
    const fact = factsById.get(id);
    if (fact) citedFacts.push(fact);
    else violations.push(`The hint cites "${id}", which is not a listed fact.`);
  }
  const citedText = citedFacts.map((fact) => fact.text).join('\n');
  const citedNonKeyText = citedFacts.filter((fact) => fact.kind !== 'key').map((fact) => fact.text).join('\n');
  const citedDescriptionText = citedFacts.filter((fact) => fact.kind === 'transaction').map((fact) => fact.text).join('\n');
  const disclosureLimited = context.rung === 2 || context.packMode;

  const knownSequences = new Set(facts.map((fact) => fact.sequence).filter((sequence): sequence is number => sequence !== undefined));
  const withoutTransactionRefs = text.replace(TRANSACTION_REFERENCE, (match, list: string) => {
    for (const value of numbersIn(list)) {
      if (!knownSequences.has(Number(value))) {
        violations.push(`The hint refers to transaction ${value}, which no listed fact describes.`);
      }
    }
    return match.replace(/\d/g, '#');
  });

  // References are checked as references below, so their digits ("010" in
  // INV-010) are not figures here.
  const withoutReferences = (value: string) =>
    referencesIn(value).reduce((remaining, reference) => remaining.split(reference).join(' '), value);
  const textFigures = numbersIn(withoutReferences(withoutTransactionRefs));
  const allowedNumbers = new Set(numbersIn(citedText.replace(/\bTransaction \d+/g, '')));
  const keyNumbers = new Set(
    facts.filter((fact) => fact.kind === 'key').flatMap((fact) => numbersIn(withoutReferences(fact.text.replace(/^Transaction \d+/, '')))),
  );
  const licenseNumbers = new Set(numbersIn(citedFacts.filter((fact) => fact.kind === 'license').map((fact) => fact.text).join(' ')));
  const unknownNumbers = [...new Set(textFigures.filter((value) => !allowedNumbers.has(value)))];
  if (unknownNumbers.length > 0) {
    violations.push(`The hint states ${unknownNumbers.join(', ')}, not written in the facts it cites. Copy figures only from a cited fact.`);
  }
  if (disclosureLimited) {
    const disclosed = [...new Set(textFigures.filter((value) => keyNumbers.has(value) && !licenseNumbers.has(value)))];
    if (disclosed.length > 0) {
      violations.push(`This step may not state figures from the answer, but it states ${disclosed.join(', ')}. Point at the transaction and the rule instead.`);
    }
  }

  const references = [...new Set(referencesIn(withoutTransactionRefs))];
  for (const reference of references) {
    const pool = disclosureLimited ? (context.packMode ? citedNonKeyText : citedDescriptionText) : citedText;
    if (!pool.toLowerCase().includes(reference.toLowerCase())) {
      violations.push(
        disclosureLimited
          ? `The hint names the reference ${reference}, which this step may only use when a cited transaction description shows it.`
          : `The hint names the reference ${reference}, not written in the facts it cites.`,
      );
    }
  }

  for (const head of new Set(gstHeadsIn(text))) {
    const pool = disclosureLimited ? citedNonKeyText : citedText;
    if (!new RegExp(`\\b${head}\\b`, 'i').test(pool)) {
      violations.push(`The hint names the GST head ${head}, which ${disclosureLimited ? 'this step may take only from a cited rulebook fact' : 'no cited fact gives'}.`);
    }
  }
  for (const section of new Set(tdsSectionsIn(text))) {
    const pool = disclosureLimited ? citedNonKeyText : citedText;
    if (!pool.includes(section)) {
      violations.push(`The hint names TDS section ${section}, which ${disclosureLimited ? 'this step may take only from a cited rulebook fact' : 'no cited fact gives'}.`);
    }
  }

  for (const name of context.keyNames) {
    if (!containsPhrase(text, name)) continue;
    if (disclosureLimited) {
      violations.push(`The hint names the ledger "${name}", which is part of the answer. This step points at the transaction and the rule, never the ledger.`);
    } else if (!containsPhrase(citedText, name)) {
      violations.push(`The hint names "${name}", which the facts it cites do not name.`);
    }
  }

  if (isEducational(context.licenseMode)) {
    const days = educationalDayViolations(text);
    if (days.length > 0) {
      violations.push(`The learner uses Tally Educational Mode, which only saves vouchers dated the 1st, 2nd or 31st, but the hint suggests ${days.map((day) => `"${day}"`).join(', ')}.`);
    }
  }

  const dash = dashViolation(text);
  if (dash) {
    violations.push(`The hint contains ${dash}. Use a colon, a comma or a full stop.`);
  }
  return violations;
}

function transactionList(sequences: number[]): string {
  if (sequences.length === 1) return `transaction ${sequences[0]}`;
  return `transactions ${sequences.slice(0, -1).join(', ')} and ${sequences[sequences.length - 1]}`;
}

function firstSentences(text: string, maxChars: number): string {
  const body = text.split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim();
  if (body.length <= maxChars) return body;
  const cut = body.slice(0, maxChars);
  const lastStop = cut.lastIndexOf('. ');
  return lastStop > 80 ? cut.slice(0, lastStop + 1) : `${cut.trim()}.`;
}

// The step composed from the facts alone, when the model cannot produce a
// grounded one in time. Plain, but true, and never more disclosure than its
// step allows: step 2 names transactions and the rule, step 3 states the key
// facts verbatim.
export function composeFallbackHint(rung: 2 | 3, concept: ConceptTag, facts: HintFact[], context: Pick<HintPromptContext, 'packMode' | 'licenseMode'>): string {
  const rule = facts.find((fact) => fact.kind === 'rule');
  const ruleSource = rule ? rulebookSourcesForConcept(concept).find((source) => source.id === rule.id) : undefined;
  const pointer = ruleSource ? ` ${rulebookPointer(ruleSource)} sets out the rule.` : '';
  const question = GUIDING_QUESTION[concept];
  const tip = isEducational(context.licenseMode) ? ` ${EDUCATIONAL_DATE_TIP}` : '';
  const keyFacts = facts.filter((fact) => fact.kind === 'key');
  const sequences = keyFacts.map((fact) => fact.sequence).filter((sequence): sequence is number => sequence !== undefined);
  const phrase = CONCEPT_PHRASE[concept];

  if (rung === 2) {
    if (context.packMode || sequences.length === 0) {
      return `In a set like this, take the most care with ${phrase}. Ask yourself: ${question}${pointer}${tip} Tell me which entry you are stuck on and I will point you at the exact rule it needs.`;
    }
    return `Look again at ${phrase} on ${transactionList(sequences)}. Ask yourself: ${question}${pointer}${tip}`;
  }
  if (context.packMode || keyFacts.length === 0) {
    const method = rule ? ` ${firstSentences(rule.text, 400)}` : '';
    return `This set is too large to solve one entry blind, so here is the method for ${phrase}.${pointer}${method} To check you have it, answer this in your own words: ${question}${tip} Then tell me which entry is blocking you and I will point you at the exact rule it needs.`;
  }
  return `Here is the full answer for ${phrase}. ${keyFacts.map((fact) => fact.text).join(' ')}${pointer} To check you have it, answer this in your own words: ${question}${tip}`;
}

// Steps 1-3 of the help flow. Step 1 is code; steps 2 and 3 are grounded
// model prose with a bounded retry and a code fallback (code-standards rule
// 35). The stored Hint shape is unchanged.
export async function generateHint(learnerId: string, context: HintPromptContext, deps?: Partial<HintDeps>): Promise<Hint> {
  const complete = deps?.complete ?? getTracedStructuredCompletion;
  const timeoutMs = deps?.timeoutMs ?? HINT_TIMEOUT_MS;
  const maxAttempts = deps?.maxAttempts ?? HINT_MAX_ATTEMPTS;
  const concept = chooseHintConcept(context);

  if (context.rung === 1) {
    return { rung: 1, hint_text: composeStepOne(concept, context.licenseMode), concept_tag: concept };
  }
  const rung: 2 | 3 = context.rung;

  const facts = buildHintFacts(context, concept);
  const grounding: HintGroundingContext = {
    rung,
    packMode: context.packMode,
    keyNames: distinctiveKeyNames(context.answerKey),
    licenseMode: context.licenseMode,
  };

  let violations: string[] = [];
  let previousOutput: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { messages, jsonSchema } =
      attempt === 1
        ? buildHintPrompt(context, facts, concept)
        : buildHintRetryPrompt(context, facts, concept, violations, previousOutput);

    let raw: unknown;
    try {
      raw = await withTimeout(
        complete({
          messages,
          jsonSchema,
          traceName: 'hint-generation',
          learnerId,
          callType: 'hint-generation',
          temperature: HINT_TEMPERATURE,
          extraMetadata: { rung, attempt, factCount: facts.length, ...(attempt > 1 ? { previousViolations: violations } : {}) },
        }),
        timeoutMs,
      );
    } catch (error) {
      // Bad JSON is a failed attempt, like coaching. A timeout ends the
      // attempts: a second 45-second wait on a model that just hung is time
      // the learner does not have, and the fallback is grounded.
      if (!isFailedAttemptError(error)) throw error;
      if (error instanceof LlmTimeoutError) break;
      violations = [`The response was not valid JSON: ${error.message}`];
      previousOutput = null;
      continue;
    }
    previousOutput = raw;

    const parsed = HintModelOutputSchema.safeParse(raw);
    violations = parsed.success
      ? checkHintGrounding(parsed.data, facts, grounding)
      : [`The response did not match the schema: ${parsed.error.message}`];
    if (parsed.success && violations.length === 0) {
      return { rung, hint_text: parsed.data.hint_text.trim(), concept_tag: concept };
    }
  }

  return { rung, hint_text: composeFallbackHint(rung, concept, facts, context), concept_tag: concept };
}
