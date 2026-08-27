import { getTracedStructuredCompletion } from '@/lib/llm/tracing';
import {
  buildAdjudicationPrompt,
  buildAdjudicationRetryPrompt,
  type FlaggedTransaction,
} from '@/lib/llm/prompts/adjudication';
import { AdjudicationSchema, type AdjudicationVerdict } from '@/lib/schemas/adjudication';
import type { AnswerKey } from '@/lib/schemas/exercise';
import type { ScoringResult, VoucherDiff } from '@/lib/schemas/scoring';
import type { ParsedDayBook } from '@/lib/schemas/voucher';
import {
  groupAnswerKeyEntriesBySequence,
  matchVouchersToTransactions,
  rebuildScoringResult,
} from '@/lib/tutor/score-submission';

const MAX_ATTEMPTS = 3;

// A submission with more flagged transactions than this isn't suffering from
// checker rigidity — it's genuinely broken (wrong period, wrong company,
// mostly-empty export), and adjudicating naming nuances on it is wasted
// tokens. The engine's verdicts stand as-is above this bound.
const MAX_ADJUDICATED_TRANSACTIONS = 50;

// Hybrid scoring, step 2 of 2 (user decision 2026-08-20): the deterministic
// engine finds, the LLM judges. Takes the engine's ScoringResult, sends every
// flagged finding to the adjudicator with the expected-vs-actual context, and
// returns a rebuilt result in which dismissed findings (acceptable practice
// variations) are flipped to correct. FAIL-SAFE by construction: any missing
// verdict, any validation failure after retries, or any thrown error leaves
// the engine's original findings standing — adjudication can only ever
// RELAX the engine, and only with an explicit per-finding verdict.
export async function adjudicateScoringResult(
  learnerId: string,
  dayBook: ParsedDayBook,
  answerKey: AnswerKey,
  scoringResult: ScoringResult,
): Promise<ScoringResult> {
  const flaggedDiffs = scoringResult.per_voucher_diffs.filter((diff) => !diff.is_correct);
  if (flaggedDiffs.length === 0) {
    return scoringResult;
  }

  const flaggedSequences = [
    ...new Set(flaggedDiffs.map((diff) => diff.voucherRef).filter((ref): ref is number => ref !== null)),
  ];
  if (flaggedSequences.length > MAX_ADJUDICATED_TRANSACTIONS) {
    return scoringResult;
  }

  const transactionGroups = groupAnswerKeyEntriesBySequence(answerKey.entries);
  const matchedVouchers = matchVouchersToTransactions(dayBook.vouchers, transactionGroups);

  const flagged: FlaggedTransaction[] = flaggedSequences.map((sequence) => {
    const groupIndex = transactionGroups.findIndex((group) => group[0].sequence === sequence);
    return {
      sequence,
      expectedLegs: groupIndex === -1 ? [] : transactionGroups[groupIndex],
      actualVoucher: groupIndex === -1 ? null : (matchedVouchers[groupIndex] ?? null),
      findings: flaggedDiffs.filter((diff) => diff.voucherRef === sequence),
    };
  });

  let verdicts: AdjudicationVerdict[] | null = null;
  try {
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { messages, jsonSchema } =
        lastError === null ? buildAdjudicationPrompt(flagged) : buildAdjudicationRetryPrompt(flagged, lastError);

      const raw = await getTracedStructuredCompletion({
        messages,
        jsonSchema,
        traceName: 'finding-adjudication',
        learnerId,
        callType: 'finding-adjudication',
        extraMetadata: { flaggedTransactions: flagged.length, flaggedFindings: flaggedDiffs.length },
      });

      const parsed = AdjudicationSchema.safeParse(raw);
      if (parsed.success) {
        verdicts = parsed.data.verdicts;
        break;
      }
      lastError = parsed.error.message;
    }
  } catch {
    verdicts = null;
  }

  if (verdicts === null) {
    // Adjudication unavailable — the engine's findings stand.
    return scoringResult;
  }

  return applyAdjudicationVerdicts(scoringResult, verdicts, answerKey);
}

// Pure application of the judge's verdicts, exported for tests. Only an
// explicit 'dismiss' for a finding's exact (sequence, field) flips it; an
// upheld or missing verdict leaves the finding untouched. The full result is
// then rebuilt so weighted score, overall result, and concept rollups always
// derive from the adjusted diffs through the one scoring code path.
export function applyAdjudicationVerdicts(
  scoringResult: ScoringResult,
  verdicts: AdjudicationVerdict[],
  answerKey: AnswerKey,
): ScoringResult {
  const dismissed = new Set(
    verdicts
      .filter((verdict) => verdict.verdict === 'dismiss')
      .map((verdict) => `${verdict.sequence}:${verdict.field}`),
  );

  if (dismissed.size === 0) {
    return scoringResult;
  }

  const adjustedDiffs: VoucherDiff[] = scoringResult.per_voucher_diffs.map((diff) => {
    if (diff.is_correct || !dismissed.has(`${diff.voucherRef}:${diff.field}`)) {
      return diff;
    }
    return { ...diff, is_correct: true, error_code: null };
  });

  return rebuildScoringResult(adjustedDiffs, scoringResult.tb_tie_out, answerKey);
}
