import { getTracedStructuredCompletion } from '@/lib/llm/tracing';
import {
  buildAdjudicationPrompt,
  buildAdjudicationRetryPrompt,
  type FlaggedFinding,
  type FlaggedTransaction,
} from '@/lib/llm/prompts/adjudication';
import { AdjudicationSchema, type AdjudicationVerdict } from '@/lib/schemas/adjudication';
import type { AnswerKey, AnswerKeyEntry } from '@/lib/schemas/exercise';
import type { ScoredField, ScoringResult, VoucherDiff } from '@/lib/schemas/scoring';
import type { LedgerEntry, ParsedDayBook, Voucher } from '@/lib/schemas/voucher';
import {
  accountNamesMatch,
  aliasAcceptsLedger,
  classifyLedger,
  isTaxLedgerName,
  namesCompatible,
  normalizeAccountName,
  partyAccountsOf,
  shareDistinctiveToken,
  shareLeadingNameToken,
} from '@/lib/tutor/account-names';
import {
  answerKeyMatchOptions,
  billReferenceTokens,
  consolidateExpectedLegs,
  groupAnswerKeyEntriesBySequence,
  pairLegsToEntries,
  rebuildScoringResult,
  referenceEntries,
  resolveScoredVouchers,
  type ScoringOptions,
} from '@/lib/tutor/score-submission';

const MAX_ATTEMPTS = 3;

// What the judge may excuse (2026-09-10 meeting): naming and reference
// FORMAT only. Amount, GST, TDS, voucher type and Dr/Cr findings are never
// sent to it and a dismiss verdict on them is ignored. In March 2025 the
// judge waved through Garima's TDS at double the rate and a freight line
// split out of a composite sale; from here on those stand as the engine
// found them. A wholly missing voucher is not a naming question either.
const DISMISSABLE_FIELDS: readonly ScoredField[] = ['account', 'bill_reference'];

export function isDismissable(diff: VoucherDiff): boolean {
  return DISMISSABLE_FIELDS.includes(diff.field) && diff.error_code !== 'VOUCHER_MISSING' && diff.error_code !== 'BILL_REFERENCE_MISSING';
}

// A submission with more flagged transactions than this isn't suffering from
// checker rigidity — it's genuinely broken (wrong period, wrong company,
// mostly-empty export), and adjudicating naming nuances on it is wasted
// tokens. The engine's verdicts stand as-is above this bound.
const MAX_ADJUDICATED_TRANSACTIONS = 50;

// ---------------------------------------------------------------------------
// What code allows the judge to excuse (2026-09-17). The prompt used to be
// the only guard, and a judge can be talked into anything by a persuasive
// ledger name or narration. A dismissal now counts only when code agrees the
// finding is a formatting or naming variation:
//
// ACCOUNT (per leg): the voucher the transaction was scored against has an
// unpaired posted entry on the leg's side with the leg's amount whose ledger
//   - is not another account of the same answer key (posting to a different
//     account of the batch is a classification error, not a name variant),
//   - is not a tax ledger, nor the leg a tax leg,
//   - passes namesCompatible (same returns status, balance-sheet marker,
//     income/expense direction, tax identity),
//   - and either matches the account or an alias outright, or belongs to the
//     same alias class: when the leg is a party (partyAccountsOf), it carries
//     the party's leading proper-name word ("Balaji" of Balaji Interiors,
//     never just the trade word "Interiors"); otherwise classifyLedger puts
//     both in the same balance-sheet or profit-and-loss class and they share
//     a distinctive word ("Maintenance of Computers" for "Repairs &
//     Maintenance"). An 'unknown' class never qualifies.
// BILL REFERENCE: the references on the party leg equal the expected ones
// once even the group boundaries are ignored (INV-10-1 against INV-101).
// After the 2026-09-17 tokenised comparison this is almost never true, by
// design: anything else is a different bill.
// ---------------------------------------------------------------------------

export type LegContext = {
  voucher: Voucher | undefined;
  legs: AnswerKeyEntry[];
  options: ScoringOptions;
  partyAccounts: Set<string>;
};

export function accountDismissalAllowed(ledger: string, leg: AnswerKeyEntry, context: Pick<LegContext, 'options' | 'partyAccounts'>): boolean {
  const account = leg.correct_account;
  const normalizedLedger = normalizeAccountName(ledger);
  if (context.options.keyAccounts?.has(normalizedLedger) && normalizedLedger !== normalizeAccountName(account)) return false;
  if (isTaxLedgerName(ledger) || isTaxLedgerName(account)) return false;
  if (!namesCompatible(ledger, account)) return false;
  if (accountNamesMatch(ledger, account, context.options)) return true;
  if ((leg.account_aliases ?? []).some((alias) => aliasAcceptsLedger(ledger, alias, account, context.options))) return true;
  if (context.partyAccounts.has(normalizeAccountName(account))) {
    return shareLeadingNameToken(ledger, account);
  }
  const ledgerKind = classifyLedger(ledger, context.partyAccounts);
  const accountKind = classifyLedger(account, context.partyAccounts);
  return (
    ledgerKind === accountKind &&
    (ledgerKind === 'balance_sheet' || ledgerKind === 'profit_and_loss') &&
    shareDistinctiveToken(ledger, account)
  );
}

function amountsAgree(entry: LedgerEntry, leg: AnswerKeyEntry): boolean {
  return Math.abs(entry.amount - leg.amount) < 0.005;
}

// The posted entry an account finding on `legIndex` is about: an unpaired
// entry on the leg's side with the leg's amount that code allows as a name
// variant. Null when there is none (the finding cannot be dismissed).
export function dismissableAccountEntry(context: LegContext, legIndex: number): LedgerEntry | null {
  if (!context.voucher) return null;
  const pairing = pairLegsToEntries(context.voucher, context.legs, context.options);
  const leg = pairing.legs[legIndex];
  if (!leg || pairing.assigned.has(legIndex)) return null;
  return (
    pairing.leftover.find(
      (entry) => entry.drOrCr === leg.dr_cr && amountsAgree(entry, leg) && accountDismissalAllowed(entry.ledgerName, leg, context),
    ) ?? null
  );
}

// Reference equality with every formatting difference removed, including
// the boundaries between letter and number groups.
function looseReference(token: string): string {
  return token.replace(/-/g, '');
}

export function billReferenceDismissalAllowed(context: LegContext): boolean {
  if (!context.voucher) return false;
  const expected = new Set(context.legs.flatMap((leg) => [...billReferenceTokens(leg.bill_reference)].map(looseReference)));
  if (expected.size === 0) return false;
  const posted = new Set<string>();
  for (const entry of referenceEntries(pairLegsToEntries(context.voucher, context.legs, context.options))) {
    for (const allocation of entry.billAllocations) {
      for (const token of billReferenceTokens(allocation.name)) posted.add(looseReference(token));
    }
  }
  const advances = new Set([...(context.options.advanceReferences ?? [])].map(looseReference));
  return [...expected].every((token) => posted.has(token)) && [...posted].every((token) => expected.has(token) || advances.has(token));
}

// Eligibility of every flagged finding, computed once per submission.
type Eligibility = {
  contexts: Map<number, LegContext>;
  accountEntries: Map<string, LedgerEntry>;
  dismissable: (diff: VoucherDiff) => boolean;
};

function findingKey(sequence: number | null, field: ScoredField, leg: number | null | undefined): string {
  return `${sequence}:${field}:${leg ?? '-'}`;
}

function computeEligibility(dayBook: ParsedDayBook, answerKey: AnswerKey): Eligibility {
  const groups = groupAnswerKeyEntriesBySequence(answerKey.entries);
  const scored = resolveScoredVouchers(dayBook, answerKey);
  const options = answerKeyMatchOptions(answerKey);
  const partyAccounts = partyAccountsOf(answerKey.entries);
  const contexts = new Map<number, LegContext>();
  groups.forEach((legs, index) => {
    contexts.set(legs[0].sequence, { voucher: scored[index], legs, options, partyAccounts });
  });
  const accountEntries = new Map<string, LedgerEntry>();
  const dismissable = (diff: VoucherDiff): boolean => {
    if (diff.is_correct || !isDismissable(diff) || diff.voucherRef === null) return false;
    const context = contexts.get(diff.voucherRef);
    if (!context) return false;
    if (diff.field === 'bill_reference') return billReferenceDismissalAllowed(context);
    if (diff.leg === undefined) return false;
    const key = findingKey(diff.voucherRef, diff.field, diff.leg);
    if (!accountEntries.has(key)) {
      const entry = dismissableAccountEntry(context, diff.leg);
      if (!entry) return false;
      accountEntries.set(key, entry);
    }
    return true;
  };
  return { contexts, accountEntries, dismissable };
}

export type AdjudicationDeps = {
  complete?: typeof getTracedStructuredCompletion;
};

// Hybrid scoring, step 2 of 2 (user decision 2026-08-20): the deterministic
// engine finds, the LLM judges. Takes the engine's ScoringResult, sends the
// flagged findings code allows to be excused to the adjudicator with the
// expected-vs-actual context, and returns a rebuilt result in which dismissed
// findings (acceptable practice variations) are flipped to correct.
// FAIL-SAFE by construction: any missing verdict, any validation failure
// after retries, or any thrown error leaves the engine's original findings
// standing — adjudication can only ever RELAX the engine, and only with an
// explicit per-finding verdict that code also accepts.
export async function adjudicateScoringResult(
  learnerId: string,
  dayBook: ParsedDayBook,
  answerKey: AnswerKey,
  scoringResult: ScoringResult,
  deps: AdjudicationDeps = {},
): Promise<ScoringResult> {
  const complete = deps.complete ?? getTracedStructuredCompletion;
  const eligibility = computeEligibility(dayBook, answerKey);
  const flaggedDiffs = scoringResult.per_voucher_diffs.filter((diff) => eligibility.dismissable(diff));
  if (flaggedDiffs.length === 0) {
    return scoringResult;
  }

  const flaggedSequences = [
    ...new Set(flaggedDiffs.map((diff) => diff.voucherRef).filter((ref): ref is number => ref !== null)),
  ];
  if (flaggedSequences.length > MAX_ADJUDICATED_TRANSACTIONS) {
    return scoringResult;
  }

  const flagged: FlaggedTransaction[] = flaggedSequences.map((sequence) => {
    const context = eligibility.contexts.get(sequence);
    const legs = context ? consolidateExpectedLegs(context.legs) : [];
    const findings: FlaggedFinding[] = flaggedDiffs
      .filter((diff) => diff.voucherRef === sequence)
      .map((diff) => ({
        field: diff.field,
        errorCode: diff.error_code,
        leg: diff.leg ?? null,
        expectedLeg: diff.leg !== undefined ? (legs[diff.leg] ?? null) : null,
        postedLedger:
          diff.leg !== undefined ? (eligibility.accountEntries.get(findingKey(sequence, diff.field, diff.leg))?.ledgerName ?? null) : null,
      }));
    return {
      sequence,
      expectedLegs: context?.legs ?? [],
      // The voucher the transaction was actually scored against, after split
      // and combined postings were resolved.
      actualVoucher: context?.voucher ?? null,
      findings,
    };
  });

  let verdicts: AdjudicationVerdict[] | null = null;
  try {
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { messages, jsonSchema } =
        lastError === null ? buildAdjudicationPrompt(flagged) : buildAdjudicationRetryPrompt(flagged, lastError);

      const raw = await complete({
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

  return applyAdjudicationVerdicts(scoringResult, verdicts, answerKey, dayBook);
}

// Pure application of the judge's verdicts, exported for tests. A dismissal
// flips a finding only when (a) the verdict names its exact sequence, field
// and, for an account finding, leg, and (b) code allows that finding to be
// excused (see above). An upheld or missing verdict leaves the finding
// untouched. Excusing a leg's account also scores that leg's side and amount,
// which were not scored while no entry belonged to the leg: the entry code
// accepted has the leg's side and amount, so both become correct. The full
// result is then rebuilt so weighted score, overall result, and concept
// rollups always derive from the adjusted diffs through the one scoring path.
export function applyAdjudicationVerdicts(
  scoringResult: ScoringResult,
  verdicts: AdjudicationVerdict[],
  answerKey: AnswerKey,
  dayBook: ParsedDayBook,
): ScoringResult {
  const dismissed = new Set(
    verdicts
      .filter((verdict) => verdict.verdict === 'dismiss')
      .map((verdict) => findingKey(verdict.sequence, verdict.field, verdict.field === 'account' ? verdict.leg : null)),
  );

  if (dismissed.size === 0) {
    return scoringResult;
  }

  const eligibility = computeEligibility(dayBook, answerKey);
  const clearedLegs = new Set<string>();
  const accepted = new Set<VoucherDiff>();
  for (const diff of scoringResult.per_voucher_diffs) {
    const key = findingKey(diff.voucherRef, diff.field, diff.field === 'account' ? diff.leg : null);
    if (!dismissed.has(key) || !eligibility.dismissable(diff)) continue;
    accepted.add(diff);
    if (diff.field === 'account') clearedLegs.add(`${diff.voucherRef}:${diff.leg}`);
  }

  if (accepted.size === 0) {
    return scoringResult;
  }

  const adjustedDiffs: VoucherDiff[] = scoringResult.per_voucher_diffs.map((diff) => {
    if (accepted.has(diff)) {
      return { ...diff, is_correct: true, error_code: null };
    }
    const cascaded =
      (diff.field === 'dr_cr' || diff.field === 'amount') && diff.leg !== undefined && clearedLegs.has(`${diff.voucherRef}:${diff.leg}`);
    if (cascaded) {
      return { voucherRef: diff.voucherRef, field: diff.field, expected_masked: true, is_correct: true, error_code: null, leg: diff.leg };
    }
    return diff;
  });

  return rebuildScoringResult(adjustedDiffs, scoringResult.tb_tie_out, answerKey, {
    tb_tie_out_mismatches: scoringResult.tb_tie_out_mismatches ?? [],
    unmatched_vouchers: scoringResult.unmatched_vouchers ?? [],
    ledger_findings: scoringResult.ledger_findings ?? [],
    composite_matches: scoringResult.composite_matches ?? [],
    books_reconciliation: scoringResult.books_reconciliation,
  });
}
