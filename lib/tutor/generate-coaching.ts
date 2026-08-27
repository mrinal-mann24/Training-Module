import { getTracedStructuredCompletion } from '@/lib/llm/tracing';
import {
  buildCoachingPrompt,
  buildCoachingRetryPrompt,
  FIELD_CONCEPT_LABELS,
  type CoachingSignal,
  type QualitativeCoachingSignal,
} from '@/lib/llm/prompts/coaching';
import { CoachingSchema, type Coaching } from '@/lib/schemas/coaching';
import type { ScoringResult, OverallResult, VoucherDiff, ScoredField } from '@/lib/schemas/scoring';
import type { AnswerKey } from '@/lib/schemas/exercise';
import type { QualitativeScoring } from '@/lib/schemas/qualitative-scoring';

const MAX_ATTEMPTS = 3;

// Turns the scoring result into concept-level descriptions only — the internal
// error code and the literal expected value never leave this function. This is
// the boundary the spec calls out: the coaching call gets "GST head was
// miscategorized on the purchase voucher," never "GST_HEAD_WRONG: expected
// IGST, got CGST."
// A learner wrong on the same field across several transactions has one
// problem, not several. Flagging each occurrence separately produces a
// dump of near-identical lines ("the ledger account classification on
// transaction 1", "... on transaction 3", "... on transaction 4") rather
// than the short, concept-level list project-overview.md describes. Diffs
// are therefore grouped by field, with the affected transactions named
// inside a single description.
// Accounts too generic to identify a transaction to the learner - when a
// sequence has no bill reference, the party/expense leg (NOT one of these)
// is what names it.
const GENERIC_ACCOUNT_PATTERN = /^(sales|purchases?|cash|bank|hdfc|output|input|gst|tds|suspense|sales returns?|purchase returns?)\b/i;

// Human identifiers per answer-key sequence: the bill/invoice reference when
// one exists ("INV-012"), else the distinctive party/expense account ("Signage
// Advertising"). Bare sequence numbers mean nothing to a learner working a
// pack exercise - the transactions live in files, not a numbered chat list -
// and feedback that says "transaction 43" reads as noise (observed live
// 2026-08-24: coaching went fully generic because the signal gave the model
// nothing nameable).
export function buildSequenceLabels(answerKey: AnswerKey): Map<number, string> {
  const labels = new Map<number, string>();
  const bySequence = new Map<number, typeof answerKey.entries>();
  for (const entry of answerKey.entries) {
    const group = bySequence.get(entry.sequence) ?? [];
    group.push(entry);
    bySequence.set(entry.sequence, group);
  }
  for (const [sequence, legs] of bySequence) {
    const billRef = legs.find((leg) => leg.bill_reference)?.bill_reference;
    if (billRef) {
      labels.set(sequence, billRef);
      continue;
    }
    const namedLeg = legs.find((leg) => !GENERIC_ACCOUNT_PATTERN.test(leg.correct_account));
    if (namedLeg) {
      labels.set(sequence, `the ${namedLeg.correct_account} ${legs[0].voucher_type.toLowerCase()}`);
      continue;
    }
    // Every leg is generic (a bank charge, the Suspense parking entry) —
    // still label it by its most descriptive leg rather than falling back to
    // a bare sequence number the learner can't act on. Prefer the non-bank/
    // cash leg ("the Suspense receipt" over "the HDFC Bank receipt").
    const descriptiveLeg = legs.find((leg) => !/^(hdfc|bank|cash)/i.test(leg.correct_account)) ?? legs[0];
    labels.set(sequence, `the ${descriptiveLeg.correct_account} ${legs[0].voucher_type.toLowerCase()}`);
  }
  return labels;
}

export function groupDescriptionsByField(
  diffs: VoucherDiff[],
  sequenceLabels?: Map<number, string>,
): string[] {
  const byField = new Map<ScoredField, number[]>();

  for (const diff of diffs) {
    const refs = byField.get(diff.field) ?? [];
    if (diff.voucherRef !== null) {
      refs.push(diff.voucherRef);
    }
    byField.set(diff.field, refs);
  }

  return [...byField.entries()].map(([field, refs]) => {
    const label = FIELD_CONCEPT_LABELS[field];
    if (refs.length === 0) {
      return label;
    }
    const sorted = [...new Set(refs)].sort((a, b) => a - b);
    const anyLabeled = sorted.some((ref) => sequenceLabels?.has(ref));
    if (!anyLabeled) {
      // No human identifiers available (generated drills, whose numbered
      // chat list makes plain numbers meaningful) - keep the compact
      // original phrasing.
      const suffix =
        sorted.length === 1
          ? `transaction ${sorted[0]}`
          : `transactions ${sorted.slice(0, -1).join(', ')} and ${sorted[sorted.length - 1]}`;
      return `${label} (${suffix})`;
    }
    const names = [
      ...new Set(sorted.map((ref) => sequenceLabels?.get(ref) ?? `transaction ${ref}`)),
    ];
    const suffix =
      names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return `${label} (${suffix})`;
  });
}

// Cap on how many distinct areas are handed to the coaching call. A learner
// told everything is wrong at once has no idea where to start — the spec
// asks for areas to re-look at, not an exhaustive error list. Highest-weighted
// fields (GST/TDS, per score-submission.ts's FIELD_WEIGHT) sort first so the
// most consequential errors survive the cap.
const MAX_FLAGGED_AREAS = 4;

const FIELD_FLAG_PRIORITY: Record<ScoredField, number> = {
  gst: 0,
  tds: 1,
  account: 2,
  dr_cr: 3,
  amount: 4,
  voucher_type: 5,
  bill_reference: 6,
  narration: 7,
};

function buildCoachingSignal(scoringResult: ScoringResult, answerKey?: AnswerKey | null): CoachingSignal {
  const sequenceLabels = answerKey ? buildSequenceLabels(answerKey) : undefined;
  const incorrectDiffs = scoringResult.per_voucher_diffs.filter((diff) => !diff.is_correct);

  // Vacuously-correct fields (the exercise required no GST/TDS and the
  // learner posted none) still count toward the weighted score, but must not
  // be offered as things done well — praising them produces feedback
  // congratulating the learner on GST/TDS handling in an exercise that
  // contained neither.
  const correctDiffs = scoringResult.per_voucher_diffs.filter(
    (diff) => diff.is_correct && !diff.vacuously_correct,
  );

  const prioritizedIncorrect = [...incorrectDiffs].sort(
    (a, b) => FIELD_FLAG_PRIORITY[a.field] - FIELD_FLAG_PRIORITY[b.field],
  );

  const incorrectConceptDescriptions = groupDescriptionsByField(prioritizedIncorrect, sequenceLabels).slice(
    0,
    MAX_FLAGGED_AREAS,
  );
  const correctConceptDescriptions = groupDescriptionsByField(correctDiffs, sequenceLabels);

  return {
    overallResult: scoringResult.overall_result,
    tbTieOut: scoringResult.tb_tie_out,
    weightedScorePercent: Math.round(scoringResult.weighted_score * 100),
    incorrectConceptDescriptions,
    correctConceptDescriptions,
    qualitative: null,
    missingPartDescriptions: [],
    rectificationDescriptions: [],
  };
}

// Plain-language buckets for each qualitative subscore — never a number, per
// the spec's "never raw subscores as numbers to the learner" rule. Coarse on
// purpose: the LLM turns these into natural prose, it doesn't need
// finer-grained input than "strong/mixed/weak" to do that well.
function describeQualitativeSubscore(value: number, dimension: 'recall' | 'precision' | 'reasoning'): string {
  const bucket = value >= 80 ? 'strong' : value >= 50 ? 'mixed' : 'weak';
  const LABEL: Record<typeof dimension, Record<'strong' | 'mixed' | 'weak', string>> = {
    recall: {
      strong: 'caught nearly all of the real issues',
      mixed: 'caught some of the real issues but missed others',
      weak: 'missed most of the real issues',
    },
    precision: {
      strong: 'rarely flagged anything that was actually correct',
      mixed: 'flagged at least one entry that was actually correct',
      weak: 'flagged several entries that were actually correct',
    },
    reasoning: {
      strong: 'explained the reasoning clearly and correctly',
      mixed: 'reasoning was partly right but not fully sound',
      weak: "reasoning didn't hold up, even where the final call was right",
    },
  };
  return LABEL[dimension][bucket];
}

function buildQualitativeCoachingSignal(qualitative: QualitativeScoring): QualitativeCoachingSignal {
  return {
    recallDescription: describeQualitativeSubscore(qualitative.recall, 'recall'),
    precisionDescription: describeQualitativeSubscore(qualitative.precision, 'precision'),
    reasoningDescription: describeQualitativeSubscore(qualitative.reasoning_quality, 'reasoning'),
  };
}

// Generates one combined feedback message covering whichever of quantitative
// (Tally posting) and qualitative (free-text answer) scoring applied to this
// exercise — a direct-entry exercise passes only scoringResult, a review
// exercise passes only qualitative, an explain exercise passes both and gets
// one feedback message weaving in both signals, per the spec's "combine...
// into the exercise's overall result" instruction and Unit 06's existing
// single-feedback-bubble UI.
export async function generateCoaching(
  learnerId: string,
  params: {
    overallResult: OverallResult;
    scoringResult: ScoringResult | null;
    qualitative: QualitativeScoring | null;
    // The exercise's answer key, so flagged areas can be NAMED by invoice/
    // party ("the GST treatment on INV-012") instead of bare sequence
    // numbers. Server-side only - identifiers named here are facts from the
    // learner's own registers, never the correct treatment itself.
    answerKey?: AnswerKey | null;
    missingPartDescriptions?: string[];
    rectificationDescriptions?: string[];
  },
): Promise<Coaching> {
  const baseSignal = params.scoringResult
    ? buildCoachingSignal(params.scoringResult, params.answerKey)
    : {
        overallResult: params.overallResult,
        tbTieOut: null,
        weightedScorePercent: null,
        incorrectConceptDescriptions: [],
        correctConceptDescriptions: [],
        qualitative: null,
        missingPartDescriptions: [],
        rectificationDescriptions: [],
      };

  const signal: CoachingSignal = {
    ...baseSignal,
    overallResult: params.overallResult,
    qualitative: params.qualitative ? buildQualitativeCoachingSignal(params.qualitative) : null,
    missingPartDescriptions: params.missingPartDescriptions ?? [],
    rectificationDescriptions: params.rectificationDescriptions ?? [],
  };

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { messages, jsonSchema } =
      lastError === null ? buildCoachingPrompt(signal) : buildCoachingRetryPrompt(signal, lastError);

    const raw = await getTracedStructuredCompletion({
      messages,
      jsonSchema,
      traceName: 'coaching',
      learnerId,
      callType: 'coaching',
    });

    const parsed = CoachingSchema.safeParse(raw);

    if (parsed.success) {
      // Factual guard beyond shape validation (2026-08-19): Zod can't catch a
      // result_line that blames the Trial Balance when tie-out actually
      // matched — observed live, prompt instruction alone was not reliable.
      // A factually-wrong line is treated as a validation failure and
      // retried; if retries exhaust, the result_line is replaced with a
      // code-composed one rather than showing the learner a false cause.
      const factualIssue = checkOpeningLineFacts(parsed.data.opening_line, signal);
      if (factualIssue === null) {
        return parsed.data;
      }
      if (attempt === MAX_ATTEMPTS) {
        return { ...parsed.data, opening_line: composeFallbackOpeningLine(signal) };
      }
      lastError = factualIssue;
      continue;
    }

    lastError = parsed.error.message;
  }

  throw new Error(`Coaching generation failed validation after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

// Returns a retry-feedback message when opening_line contradicts the computed
// scoring facts, null when it's consistent. Exported for tests.
export function checkOpeningLineFacts(openingLine: string, signal: CoachingSignal): string | null {
  if (signal.tbTieOut === true && /trial\s*balance/i.test(openingLine)) {
    return 'Your opening_line attributes the result to the Trial Balance, but the Trial Balance tie-out MATCHED. Restate the opening_line without mentioning the Trial Balance.';
  }
  return null;
}

// Deterministic opening line used only when the model repeatedly produces a
// factually-wrong one: plain and safe rather than clever, score included when
// available, no em dashes (learner-facing hard rule).
export function composeFallbackOpeningLine(signal: CoachingSignal): string {
  const scorePrefix =
    signal.weightedScorePercent === null ? '' : `Your submission came in at ${signal.weightedScorePercent} percent. `;
  if (signal.overallResult === 'pass') {
    return `${scorePrefix}This submission passes.`;
  }
  if (signal.overallResult === 'partial') {
    return `${scorePrefix}A partial result: some entries are right, and a few areas below need another look.`;
  }
  return `${scorePrefix}This one did not pass yet. The areas below are where to focus.`;
}
