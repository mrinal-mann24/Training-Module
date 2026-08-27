import { getTracedStructuredCompletion } from '@/lib/llm/tracing';
import {
  buildQualitativeScoringPrompt,
  buildQualitativeScoringRetryPrompt,
  type QualitativeGroundingItem,
} from '@/lib/llm/prompts/qualitative-scoring';
import { QualitativeScoringSchema, type QualitativeScoring } from '@/lib/schemas/qualitative-scoring';
import type { AnswerKey } from '@/lib/schemas/exercise';
import type { OverallResult } from '@/lib/schemas/scoring';

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

// ASSUMPTION: standing in for the real Karbon VA House Practices Rulebook,
// same placeholder pattern as lib/llm/prompts/coaching.ts — swap for real
// Rulebook content/retrieval once it exists, no restructuring needed.
const RULEBOOK_GROUNDING_PLACEHOLDER = `Grounding reference (placeholder standing in for the Karbon VA House Practices Rulebook):
- GST head selection: IGST applies for inter-state supply; CGST+SGST together apply for intra-state supply.
- TDS applies when a payment crosses the prescribed threshold for its section; correctness depends on the nature of the payment.
- Every purchase/payment/sales/receipt voucher against a running party balance should carry a bill-by-bill reference.
- Narration should state what the transaction is and why, in plain language.
- Trial Balance tie-out is the check that catches an entry that "looks right" per voucher but doesn't actually net correctly.`;

// Unit 11: qualitative scoring genuinely calls the LLM (unlike Unit 06's
// score-submission.ts, which is deterministic) because free-text natural
// language can't be code-diffed. Grounded tightly against a server-only
// issue list — the caller passes exactly what "the real issues" are for
// this exercise, never the learner-facing packet/scenario text alone — so
// the model is judging against ground truth, not improvising. Same bounded
// 3-attempt retry + Zod validation discipline as every other LLM call.
export async function scoreQualitative(
  learnerId: string,
  params: {
    learnerText: string;
    groundingItems: QualitativeGroundingItem[];
    traceName: string;
  },
): Promise<QualitativeScoring> {
  const input = {
    learnerText: params.learnerText,
    groundingItems: params.groundingItems,
    rulebookGrounding: RULEBOOK_GROUNDING_PLACEHOLDER,
  };

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { messages, jsonSchema } =
      lastError === null
        ? buildQualitativeScoringPrompt(input)
        : buildQualitativeScoringRetryPrompt(input, lastError);

    const raw = await getTracedStructuredCompletion({
      messages,
      jsonSchema,
      traceName: params.traceName,
      learnerId,
      callType: 'qualitative-scoring',
    });

    const parsed = QualitativeScoringSchema.safeParse(raw);

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
