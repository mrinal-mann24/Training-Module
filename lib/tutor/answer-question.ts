import { getTracedStructuredCompletion, type TracedCompletionParams } from '@/lib/llm/tracing';
import { buildQaPrompt, buildQaRetryPrompt, buildQaSources, type QaContext } from '@/lib/llm/prompts/qa';
import { QaModelOutputSchema, type QaModelOutput, type QaResponse } from '@/lib/schemas/qa';
import type { LicenseMode } from '@/lib/schemas/onboarding';
import {
  EDUCATIONAL_DATE_TIP,
  LlmTimeoutError,
  RULEBOOK_SOURCES,
  TDS_SECTION_PATTERN,
  VIDEO_TITLES,
  dashViolation,
  educationalDayViolations,
  isEducational,
  isFailedAttemptError,
  numbersIn,
  referencesIn,
  rulebookPointer,
  withTimeout,
  type GroundingSource,
} from '@/lib/tutor/grounded-prose';

// The learner is waiting in chat: two attempts of at most 45 seconds each,
// and a timeout goes straight to the fallback (2026-09-17).
export const QA_TIMEOUT_MS = 45_000;
export const QA_MAX_ATTEMPTS = 2;

const QA_TEMPERATURE = 0.2;

export type QaDeps = {
  complete: (params: TracedCompletionParams) => Promise<unknown>;
  timeoutMs: number;
  maxAttempts: number;
};

// Composed in code, so a question that pastes the current exercise's figures
// never reaches a model that might work it (2026-09-17).
export const CURRENT_EXERCISE_REPLY =
  'That looks like an entry from your current exercise, so I won\'t solve it here. Use the "I\'m stuck" help on the exercise: it first points you to the right video, then gives a pointed hint, then the full answer with the explanation.';

// Dates and years are not amounts ("01-06-2024", "June 2024").
const MONTH_WORD = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
const DATE_TOKEN = new RegExp(String.raw`\b\d{1,2}[-/.\s](?:\d{1,2}|${MONTH_WORD})[-/.\s]\d{2,4}\b|\b${MONTH_WORD}\.?\s+\d{4}\b`, 'gi');

function amountsIn(text: string): string[] {
  const withoutDatesOrRefs = referencesIn(text).reduce((remaining, reference) => remaining.split(reference).join(' '), text.replace(DATE_TOKEN, ' '));
  return numbersIn(withoutDatesOrRefs).filter((value) => {
    const number = Number(value);
    const yearLike = Number.isInteger(number) && number >= 1900 && number <= 2100;
    return number >= 100 && !yearLike;
  });
}

export type ExerciseFingerprint = { amounts: ReadonlySet<string>; references: ReadonlySet<string>; maxSequence: number };

export function exerciseFingerprint(context: Pick<QaContext, 'exerciseScenario' | 'exerciseTransactions'>): ExerciseFingerprint {
  const transactions = context.exerciseTransactions ?? [];
  const text = [context.exerciseScenario ?? '', ...transactions.map((transaction) => transaction.description)].join('\n');
  return {
    amounts: new Set(amountsIn(text)),
    references: new Set(referencesIn(text).map((reference) => reference.toLowerCase())),
    maxSequence: transactions.reduce((max, transaction) => Math.max(max, transaction.sequence), 0),
  };
}

// A question carrying one of the current exercise's amounts or bill
// references, or naming one of its numbered transactions, is a request to
// solve that entry.
export function targetsCurrentExercise(question: string, fingerprint: ExerciseFingerprint): boolean {
  if (amountsIn(question).some((amount) => fingerprint.amounts.has(amount))) return true;
  if (referencesIn(question).some((reference) => fingerprint.references.has(reference.toLowerCase()))) return true;
  const numbered = /\b(?:transaction|entry)\s+(?:no\.?\s*|number\s+)?(\d{1,3})\b/i.exec(question);
  return numbered !== null && fingerprint.maxSequence > 0 && Number(numbered[1]) <= fingerprint.maxSequence;
}

export type QaGroundingContext = {
  licenseMode?: LicenseMode | null;
  exercise: ExerciseFingerprint;
};

// Small counts ("two ledgers", "3 steps") are ordinary prose, not rates or
// thresholds. A small number is still checked when it is a percentage or a
// section/rule number.
const SMALL_COUNT_LIMIT = 10;
const SECTION_LEAD = /\b(?:section|sec\.?|u\/s|rule|rulebook)\s*$/i;

// The Q&A contract, checked in code (2026-09-17). Returns every violation,
// phrased to hand back to the model; empty means grounded. The rules:
//  - at least one citation, every one a listed source;
//  - every figure, percentage and section or rule number occurs in the cited
//    sources, and "Rulebook N" names a cited rulebook section;
//  - every quoted title is a video registry title or text from a cited source;
//  - no figure or bill reference from the learner's current exercise;
//  - Educational Mode learners get no posting day but the 1st, 2nd or 31st;
//  - no em dash or en dash.
export function checkQaGrounding(output: QaModelOutput, sources: readonly GroundingSource[], context: QaGroundingContext): string[] {
  const violations: string[] = [];
  const answer = output.answer;
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const cited: GroundingSource[] = [];
  if (output.citations.length === 0) {
    violations.push('The answer cites no sources. List the id of every source it relies on.');
  }
  for (const id of output.citations) {
    const source = sourcesById.get(id);
    if (source) cited.push(source);
    else violations.push(`The answer cites "${id}", which is not a listed source.`);
  }
  const citedText = cited.map((source) => `${source.title}\n${source.text}`).join('\n');
  const citedNumbers = new Set(numbersIn(citedText));

  const references = referencesIn(answer);
  for (const reference of new Set(references)) {
    if (context.exercise.references.has(reference.toLowerCase())) {
      violations.push(`The answer uses ${reference} from the learner's current exercise. Never work an entry of the current exercise; point to the help steps instead.`);
    } else if (!citedText.toLowerCase().includes(reference.toLowerCase())) {
      violations.push(`The answer uses the reference ${reference}, which no cited source contains.`);
    }
  }

  const masked = references.reduce((remaining, reference) => remaining.split(reference).join(' '.repeat(reference.length)), answer);
  const figurePattern = /\d[\d,]*(?:\.\d+)?/g;
  const unsupported = new Set<string>();
  let figure: RegExpExecArray | null;
  while ((figure = figurePattern.exec(masked)) !== null) {
    const value = numbersIn(figure[0])[0];
    if (value === undefined) continue;
    const after = masked.slice(figure.index + figure[0].length);
    const before = masked.slice(0, figure.index);
    const isRate = /^\s*(?:%|percent)/i.test(after);
    const isSection = SECTION_LEAD.test(before);
    const isOrdinal = /^(?:st|nd|rd|th)\b/i.test(after);
    if (Number(value) <= SMALL_COUNT_LIMIT && !isRate && !isSection && !isOrdinal) continue;
    if (!citedNumbers.has(value)) unsupported.add(isRate ? `${value}%` : value);
  }
  if (unsupported.size > 0) {
    violations.push(`The answer states ${[...unsupported].join(', ')}, not written in any source it cites. Quote rates, thresholds, amounts and section numbers only from a cited source.`);
  }

  for (const amount of new Set(amountsIn(answer))) {
    if (context.exercise.amounts.has(amount) && !citedNumbers.has(amount)) {
      violations.push(`The answer uses the amount ${amount} from the learner's current exercise. Never work an entry of the current exercise.`);
    }
  }

  const sectionPattern = /\b(?:section|sec\.?|u\/s)\s*(\d{1,3}[A-Z]{0,2})\b/gi;
  const sections = new Set([...answer.matchAll(sectionPattern)].map((match) => match[1]).concat(answer.match(TDS_SECTION_PATTERN) ?? []));
  for (const section of sections) {
    if (!new RegExp(`\\b${section}\\b`, 'i').test(citedText)) {
      violations.push(`The answer names section ${section}, which no cited source contains.`);
    }
  }
  for (const match of answer.matchAll(/\bRulebook(?:\s+section)?\s+(\d{1,2}(?:\.\d{1,2})?[A-C]?)\b/gi)) {
    const id = `R${match[1].toUpperCase()}`;
    const covered = output.citations.some((citation) => citation === id || citation.startsWith(`${id}.`) || id.startsWith(`${citation}.`));
    if (!covered) {
      violations.push(`The answer points to Rulebook ${match[1]} without citing ${id}.`);
    }
  }

  for (const match of answer.matchAll(/["“]([^"”]{6,})["”]/g)) {
    const title = match[1].trim();
    if (VIDEO_TITLES.has(title) || citedText.toLowerCase().includes(title.toLowerCase())) continue;
    if (title.split(/\s+/).length >= 3) {
      violations.push(`The answer quotes "${title}", which is not a video registry title or text from a cited source. Name modules only by their exact registry title.`);
    }
  }

  if (isEducational(context.licenseMode)) {
    const days = educationalDayViolations(answer);
    if (days.length > 0) {
      violations.push(`The learner uses Tally Educational Mode, which only saves vouchers dated the 1st, 2nd or 31st, but the answer suggests ${days.map((day) => `"${day}"`).join(', ')}.`);
    }
  }

  const dash = dashViolation(answer);
  if (dash) {
    violations.push(`The answer contains ${dash}. Use a colon, a comma or a full stop.`);
  }
  return violations;
}

// Which rulebook section a question is most likely about, for the fallback.
const QUESTION_SECTIONS: [RegExp, string][] = [
  [/\btds\b|\b19[2-6][a-z]{0,2}\b|\bdeduct/i, 'R12'],
  [/\bgst\b|\bigst\b|\bcgst\b|\bsgst\b|\bitc\b|input tax|reverse charge|\brcm\b/i, 'R13'],
  [/\badvance/i, 'R9'],
  [/bill[- ]by[- ]bill|against ref|new ref|on account/i, 'R4'],
  [/\bnarration/i, 'R3'],
  [/voucher type|which voucher|\bf[4-9]\b/i, 'R5'],
  [/reconcil|bank statement|\bbrs\b/i, 'R14'],
  [/mistake|\berror|revers|rectif/i, 'R15'],
  [/expense|creditor/i, 'R11'],
  [/\bledger|\bgroup/i, 'R2'],
  [/\bpayment|\bpaid\b|\bpay\b/i, 'R6'],
  [/\breceipt|\breceived?\b/i, 'R7'],
];

// The answer composed in code when no grounded answer arrives in time: an
// honest "not reliably" plus where in the rulebook to look.
export function composeFallbackAnswer(context: Pick<QaContext, 'question' | 'licenseMode'>): string {
  const sectionId = QUESTION_SECTIONS.find(([pattern]) => pattern.test(context.question))?.[1];
  const section = sectionId ? RULEBOOK_SOURCES.find((source) => source.id === sectionId) : undefined;
  const pointer = section
    ? `Here is the relevant rulebook section: ${rulebookPointer(section)}.`
    : 'The House Practices Rulebook is the place to start.';
  const tip = isEducational(context.licenseMode) && /\bdate|\bday\b|\bdated\b/i.test(context.question) ? ` ${EDUCATIONAL_DATE_TIP}` : '';
  return `I can't answer that reliably yet. ${pointer}${tip} If it still isn't clear, flag it to your reviewer.`;
}

// Unit 15R: answers a learner's free-form chat question. Grounded
// (2026-09-17, code-standards rule 35): code first refuses to work the
// current exercise, then the model answers from cited sources, the answer is
// checked in code, violations go back for one bounded retry, and a
// code-composed answer is used when that fails. The answer key never enters
// this context.
export async function answerQuestion(learnerId: string, context: QaContext, deps?: Partial<QaDeps>): Promise<QaResponse> {
  const complete = deps?.complete ?? getTracedStructuredCompletion;
  const timeoutMs = deps?.timeoutMs ?? QA_TIMEOUT_MS;
  const maxAttempts = deps?.maxAttempts ?? QA_MAX_ATTEMPTS;

  const exercise = exerciseFingerprint(context);
  if (targetsCurrentExercise(context.question, exercise)) {
    return { answer: CURRENT_EXERCISE_REPLY };
  }

  const sources = buildQaSources(context.licenseMode);
  const grounding: QaGroundingContext = { licenseMode: context.licenseMode, exercise };
  let violations: string[] = [];
  let previousOutput: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { messages, jsonSchema } =
      attempt === 1 ? buildQaPrompt(context, sources) : buildQaRetryPrompt(context, sources, violations, previousOutput);

    let raw: unknown;
    try {
      raw = await withTimeout(
        complete({
          messages,
          jsonSchema,
          traceName: 'qa-response',
          learnerId,
          callType: 'qa-response',
          temperature: QA_TEMPERATURE,
          extraMetadata: { attempt, ...(attempt > 1 ? { previousViolations: violations } : {}) },
        }),
        timeoutMs,
      );
    } catch (error) {
      if (!isFailedAttemptError(error)) throw error;
      if (error instanceof LlmTimeoutError) break;
      violations = [`The response was not valid JSON: ${error.message}`];
      previousOutput = null;
      continue;
    }
    previousOutput = raw;

    const parsed = QaModelOutputSchema.safeParse(raw);
    violations = parsed.success
      ? checkQaGrounding(parsed.data, sources, grounding)
      : [`The response did not match the schema: ${parsed.error.message}`];
    if (parsed.success && violations.length === 0) {
      return { answer: parsed.data.answer.trim() };
    }
  }

  return { answer: composeFallbackAnswer(context) };
}
