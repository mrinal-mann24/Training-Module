import { getTracedStructuredCompletion, type TracedCompletionParams } from '@/lib/llm/tracing';
import {
  buildQualitativeScoringPrompt,
  buildQualitativeScoringRetryPrompt,
  type QualitativeGroundingItem,
} from '@/lib/llm/prompts/qualitative-scoring';
import { QualitativeScoringSchema, type QualitativeScoring } from '@/lib/schemas/qualitative-scoring';
import type { AnswerKey, ConceptTag } from '@/lib/schemas/exercise';
import type { OverallResult } from '@/lib/schemas/scoring';
import { RULEBOOK_SECTIONS_BY_CONCEPT, rulebookSourcesFor } from '@/lib/tutor/grounded-prose';

const MAX_ATTEMPTS = 3;

// Same pass/partial/fail thresholds as scoring.ts's quantitative scorer,
// applied to the qualitative subscores' average — kept as separate named
// constants (not reused from scoring.ts) since the two are conceptually
// distinct thresholds that happen to share a value today, not one shared
// invariant. GST/TDS-style 2x weighting doesn't apply here: recall,
// precision, and reasoning_quality are weighted equally, since nothing in
// the spec calls for a qualitative equivalent of that weighting.
const QUALITATIVE_PASS_THRESHOLD = 90;
const QUALITATIVE_PARTIAL_THRESHOLD = 60;

function qualitativeAverage(score: QualitativeScoring): number {
  return (score.recall + score.precision + score.reasoning_quality) / 3;
}

function overallResultFromQualitative(score: QualitativeScoring): OverallResult {
  const average = qualitativeAverage(score);
  if (average >= QUALITATIVE_PASS_THRESHOLD) {
    return 'pass';
  }
  if (average >= QUALITATIVE_PARTIAL_THRESHOLD) {
    return 'partial';
  }
  return 'fail';
}

const RESULT_RANK: Record<OverallResult, number> = { fail: 0, partial: 1, pass: 2 };

// Combines a quantitative overall_result (Unit 06's score-submission.ts, for
// exercises with a Tally posting) with a qualitative one (this file) into a
// single overall_result for the exercise — spec's "combine qualitative and
// quantitative scores into the exercise's overall result when both apply."
// Takes the worse of the two: a learner who posts a clean voucher set but
// writes a shallow/wrong explanation hasn't actually demonstrated the
// judgment this exercise is testing, and vice versa. When only one applies
// (direct-entry exercises have no qualitative score; review exercises have
// no quantitative score), that one result is used as-is.
export function combineOverallResult(
  quantitative: OverallResult | null,
  qualitative: QualitativeScoring | null,
): OverallResult {
  if (quantitative !== null && qualitative !== null) {
    const qualitativeResult = overallResultFromQualitative(qualitative);
    return RESULT_RANK[quantitative] <= RESULT_RANK[qualitativeResult] ? quantitative : qualitativeResult;
  }
  if (qualitative !== null) {
    return overallResultFromQualitative(qualitative);
  }
  if (quantitative !== null) {
    return quantitative;
  }
  throw new Error('combineOverallResult requires at least one of quantitative or qualitative to be non-null.');
}

const MAX_EXCERPT_CHARS = 3000;
const MAX_RATIONALE_CHARS = 2000;

// Which rulebook sections an issue list is about, when the caller does not
// name the concepts. Explain exercises carry the answer key's own fields
// (account, voucher type, GST, TDS, bill reference); review exercises carry
// anomaly/correct verdicts, which the common-errors and quality-bar sections
// govern.
const ITEM_SECTIONS: [RegExp, string[]][] = [
  [/\bGST\b/, ['R13']],
  [/\bTDS\b/, ['R12.1', 'R12.4']],
  [/bill reference/i, ['R4']],
  [/narration/i, ['R3']],
  [/voucher type/i, ['R5']],
  [/\baccount:/i, ['R2', 'R11']],
  [/anomaly|actually correct/i, ['R15', 'R16']],
];

// The real rulebook excerpts for the concepts being graded (2026-09-17). The
// grader was given a five-line placeholder "standing in for" the rulebook
// long after the real one was extracted, so a learner stating the house rule
// correctly could be marked against a paraphrase of it.
export function rulebookGroundingFor(items: readonly QualitativeGroundingItem[], conceptTags?: readonly ConceptTag[]): string {
  const ids =
    conceptTags && conceptTags.length > 0
      ? conceptTags.flatMap((tag) => RULEBOOK_SECTIONS_BY_CONCEPT[tag] ?? [])
      : (() => {
          const text = items.map((item) => `${item.label} ${item.detail}`).join('\n');
          const matched = ITEM_SECTIONS.filter(([pattern]) => pattern.test(text)).flatMap(([, sections]) => sections);
          return matched.length > 0 ? matched : ['R15', 'R16'];
        })();
  return rulebookSourcesFor([...new Set(ids)])
    .map((source) => `[${source.id}] ${source.text.length > MAX_EXCERPT_CHARS ? source.text.slice(0, MAX_EXCERPT_CHARS) : source.text}`)
    .join('\n\n');
}

function toScore(value: unknown): unknown {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return value;
  return Math.min(100, Math.max(0, Math.round(number)));
}

// Clamp and round before validating (2026-09-17). A subscore of 100.4, or
// "85" as a string, is a usable grade, and a retry for it costs the learner a
// minute; NaN, a missing field or a word is still rejected by the schema.
// These numbers only ever reach the learner as code-written rubric lines
// (generate-coaching.ts describeQualitativeSubscore), and the rationale never
// does.
export function normalizeQualitativeOutput(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const record = raw as Record<string, unknown>;
  return {
    ...record,
    recall: toScore(record.recall),
    precision: toScore(record.precision),
    reasoning_quality: toScore(record.reasoning_quality),
    rationale: typeof record.rationale === 'string' ? record.rationale.slice(0, MAX_RATIONALE_CHARS) : record.rationale,
  };
}

export type QualitativeScoringDeps = {
  complete: (params: TracedCompletionParams) => Promise<unknown>;
};

// Unit 11: qualitative scoring genuinely calls the LLM (unlike Unit 06's
// score-submission.ts, which is deterministic) because free-text natural
// language can't be code-diffed. Grounded tightly against a server-only
// issue list — the caller passes exactly what "the real issues" are for
// this exercise, never the learner-facing packet/scenario text alone — so
// the model is judging against ground truth, not improvising. Bounded
// 3-attempt retry with validation; malformed JSON counts as a failed attempt
// (2026-09-17). This runs inside an Inngest step, so exhausting the attempts
// still throws and the step retries.
export async function scoreQualitative(
  learnerId: string,
  params: {
    learnerText: string;
    groundingItems: QualitativeGroundingItem[];
    traceName: string;
    // The concepts graded, when the caller knows them; otherwise inferred
    // from the issue list.
    conceptTags?: ConceptTag[];
  },
  deps?: Partial<QualitativeScoringDeps>,
): Promise<QualitativeScoring> {
  const complete = deps?.complete ?? getTracedStructuredCompletion;
  const input = {
    learnerText: params.learnerText,
    groundingItems: params.groundingItems,
    rulebookGrounding: rulebookGroundingFor(params.groundingItems, params.conceptTags),
  };

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { messages, jsonSchema } =
      lastError === null
        ? buildQualitativeScoringPrompt(input)
        : buildQualitativeScoringRetryPrompt(input, lastError);

    let raw: unknown;
    try {
      raw = await complete({
        messages,
        jsonSchema,
        traceName: params.traceName,
        learnerId,
        callType: 'qualitative-scoring',
      });
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      lastError = `The response was not valid JSON: ${error.message}`;
      continue;
    }

    const parsed = QualitativeScoringSchema.safeParse(normalizeQualitativeOutput(raw));

    if (parsed.success) {
      return parsed.data;
    }

    lastError = parsed.error.message;
  }

  throw new Error(`Qualitative scoring failed validation after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

// Grounding for an 'explain' exercise's explain_text: the exercise's own
// answer_key (server-only, same handling discipline as everywhere else it's
// touched) — the learner explains *why* they posted the entries the way
// they did, so the real issue list is what the answer key's entries
// actually turn on (account/GST/TDS/etc. per transaction), not a separate
// hand-authored explanation key. Confirmed with the user rather than adding
// new schema surface the spec doesn't ask for.
export function groundingFromAnswerKey(answerKey: AnswerKey): QualitativeGroundingItem[] {
  return answerKey.entries.map((entry) => {
    const details: string[] = [
      `account: ${entry.correct_account} (${entry.dr_cr})`,
      `voucher type: ${entry.voucher_type}`,
    ];
    if (entry.gst_head) {
      details.push(`GST: ${entry.gst_head} @ ${entry.gst_rate ?? 'n/a'}%`);
    }
    if (entry.tds_section) {
      details.push(`TDS: section ${entry.tds_section} @ ${entry.tds_rate ?? 'n/a'}%`);
    }
    if (entry.bill_reference) {
      details.push(`bill reference: ${entry.bill_reference}`);
    }
    return { label: `Transaction ${entry.sequence}`, detail: details.join(', ') };
  });
}
