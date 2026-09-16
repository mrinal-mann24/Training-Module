import { getTracedStructuredCompletion, recordCoachingGroundingViolations, type TracedCompletionParams } from '@/lib/llm/tracing';
import {
  buildCoachingPrompt,
  buildCoachingRetryPrompt,
  FACT_ID_PREFIX,
  FIELD_CONCEPT_LABELS,
  type CoachingFact,
  type CoachingFactKind,
  type CoachingSignal,
  type QualitativeCoachingSignal,
  type RectificationNote,
} from '@/lib/llm/prompts/coaching';
import { CoachingModelOutputSchema, type Coaching, type CoachingModelOutput } from '@/lib/schemas/coaching';
import type {
  ScoringResult,
  OverallResult,
  VoucherDiff,
  ScoredField,
  TieOutMismatch,
  UnmatchedVoucher,
  LedgerFinding,
  CompositeMatch,
} from '@/lib/schemas/scoring';
import type { AnswerKey } from '@/lib/schemas/exercise';
import type { QualitativeScoring } from '@/lib/schemas/qualitative-scoring';
import type { CorrectionDecision } from '@/lib/tutor/correction-round';

const MAX_ATTEMPTS = 3;

// Coaching phrases a fixed fact list; it has no use for creative sampling.
const COACHING_TEMPERATURE = 0.2;

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
      // Bill references come from the SOURCE PACK, not the learner's books —
      // a learner who never entered the Against Ref cannot find "INV-M-101"
      // anywhere in their Tally (reported verbatim by the first real intern,
      // 2026-08-31). Pair the ref with the party/voucher-type so the label
      // locates the entry even when the ref itself is absent from their
      // books: "INV-M-101 (the Karnataka Emporium receipt)".
      const partyLeg = legs.find((leg) => !GENERIC_ACCOUNT_PATTERN.test(leg.correct_account));
      labels.set(
        sequence,
        partyLeg
          ? `${billRef} (the ${partyLeg.correct_account} ${legs[0].voucher_type.toLowerCase()})`
          : billRef,
      );
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
    const descriptiveLeg = legs.find((leg) => !/^(hdfc|bank|cash)\b/i.test(leg.correct_account)) ?? legs[0];
    labels.set(sequence, `the ${descriptiveLeg.correct_account} ${legs[0].voucher_type.toLowerCase()}`);
  }

  // Collision guardrail (2026-09-01): two different transactions can produce
  // the same label (the key has two "Bank Charges" payments) — praise for one
  // and a flag for the other then read as the tool contradicting itself.
  // Colliding labels get the transaction's amount appended (a fact from the
  // learner's own source documents, so it never leaks the answer key).
  const sequencesByLabel = new Map<string, number[]>();
  for (const [sequence, label] of labels) {
    const group = sequencesByLabel.get(label) ?? [];
    group.push(sequence);
    sequencesByLabel.set(label, group);
  }
  for (const [label, sequences] of sequencesByLabel) {
    if (sequences.length < 2) {
      continue;
    }
    for (const sequence of sequences) {
      const amount = bySequence.get(sequence)?.[0]?.amount;
      if (amount !== undefined) {
        labels.set(sequence, `${label} of Rs. ${Math.abs(amount).toLocaleString('en-IN')}`);
      }
    }
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

// No cap on flagged areas (removed 2026-09-16). The list is already grouped
// by field, so it tops out at one entry per scored field plus the
// not-recorded entry, and the old silent cap of six meant a learner could be
// told less than the scoring engine found with nothing saying so. Every
// finding now reaches the learner, in the model's words or the fallback's.
// Highest-weighted fields (GST/TDS, per score-submission.ts's FIELD_WEIGHT)
// still sort first so the most consequential errors lead.
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

export function buildCoachingSignal(scoringResult: ScoringResult, answerKey?: AnswerKey | null): CoachingSignal {
  const sequenceLabels = answerKey ? buildSequenceLabels(answerKey) : undefined;

  // Only diffs carrying a real error code were actually ASSESSED as wrong.
  // When a leg's account never matched, its dr_cr and amount diffs are
  // emitted incorrect-with-null-code (they drag the score, but direction and
  // amount were never judged — there was no entry to judge). Feeding those
  // into the flagged areas told a live learner to "reconsider the debit and
  // credit direction" on a voucher whose direction was textbook-correct
  // (INV-010, pilot 2026-08-31) — the only real finding there was the
  // account, which ACCOUNT_WRONG already covers.
  const incorrectDiffs = scoringResult.per_voucher_diffs.filter(
    (diff) => !diff.is_correct && diff.error_code !== null,
  );

  // A transaction the learner never posted is its own kind of finding, not a
  // "ledger account classification" problem (VOUCHER_MISSING's host field).
  // Split it out and name it plainly; the remaining field groups describe
  // only vouchers that actually exist in the submission.
  const missingDiffs = incorrectDiffs.filter((diff) => diff.error_code === 'VOUCHER_MISSING');
  const assessedIncorrect = incorrectDiffs.filter((diff) => diff.error_code !== 'VOUCHER_MISSING');

  // Vacuously-correct fields (the exercise required no GST/TDS and the
  // learner posted none) still count toward the weighted score, but must not
  // be offered as things done well — praising them produces feedback
  // congratulating the learner on GST/TDS handling in an exercise that
  // contained neither.
  //
  // Praise/flag exclusivity guardrail (2026-09-01): a transaction with ANY
  // flagged field is dropped from the praise side entirely — "DT-115 handled
  // well" and "revisit DT-115" in the same feedback is factually consistent
  // (different fields) but reads as the tool contradicting itself to a
  // learner. Praise only fully-clean transactions.
  //
  // Field exclusivity (2026-09-16): the same holds per FIELD. Template595's
  // review said "Bill-by-bill referencing was handled correctly" directly
  // above three flagged bill references, because the clean transactions'
  // correct bill_reference diffs were praised as a group. A field is praised
  // only when not one diff of it was flagged in this submission.
  const flaggedSequences = new Set(
    incorrectDiffs.map((diff) => diff.voucherRef).filter((ref): ref is number => ref !== null),
  );
  const flaggedFields = new Set(assessedIncorrect.map((diff) => diff.field));
  const correctDiffs = scoringResult.per_voucher_diffs.filter(
    (diff) =>
      diff.is_correct &&
      !diff.vacuously_correct &&
      !flaggedFields.has(diff.field) &&
      (diff.voucherRef === null || !flaggedSequences.has(diff.voucherRef)),
  );

  const prioritizedIncorrect = [...assessedIncorrect].sort(
    (a, b) => FIELD_FLAG_PRIORITY[a.field] - FIELD_FLAG_PRIORITY[b.field],
  );

  const missingDescriptions: string[] = [];
  if (missingDiffs.length > 0) {
    const names = [
      ...new Set(
        missingDiffs.map((diff) =>
          diff.voucherRef !== null
            ? (sequenceLabels?.get(diff.voucherRef) ?? `transaction ${diff.voucherRef}`)
            : 'a transaction',
        ),
      ),
    ];
    const suffix =
      names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    missingDescriptions.push(
      `entries that appear not to have been recorded in the Day Book at all (${suffix})`,
    );
  }

  const incorrectConceptDescriptions = [
    ...missingDescriptions,
    ...groupDescriptionsByField(prioritizedIncorrect, sequenceLabels),
  ];
  const correctConceptDescriptions = groupDescriptionsByField(correctDiffs, sequenceLabels);

  return {
    overallResult: scoringResult.overall_result,
    tbTieOut: scoringResult.tb_tie_out,
    tbMismatchDescriptions: describeTieOutMismatches(scoringResult.tb_tie_out_mismatches ?? []),
    unmatchedVoucherDescriptions: describeUnmatchedVouchers(scoringResult.unmatched_vouchers ?? []),
    ledgerFindingDescriptions: describeLedgerFindings(scoringResult.ledger_findings ?? []),
    compositeDescriptions: describeCompositeMatches(scoringResult.composite_matches ?? [], sequenceLabels),
    booksReconciliation:
      scoringResult.books_reconciliation === undefined
        ? null
        : { clean: scoringResult.books_reconciliation.length === 0, descriptions: describeBooksReconciliation(scoringResult.books_reconciliation) },
    incorrectConceptDescriptions,
    correctConceptDescriptions,
    qualitative: null,
    missingPartDescriptions: [],
    rectifications: [],
  };
}

// Which ledgers the Trial Balance could not reconcile and by how much
// (2026-09-09, movement-based tie-out). The gap is the learner's own
// figure against the correct movement, never the expected figure, so the
// coaching can point at the ledger without handing over the answer. Capped
// so a badly exported Trial Balance does not flood the prompt; the cap is
// stated as its own line, never silent.
const MAX_TIE_OUT_MISMATCHES = 6;

// The difference is Dr-positive (learner's signed movement minus the correct
// one). It used to be rendered as "moved by Rs X more/less", which reads
// backwards for a credit ledger: Sales carrying LESS credit than it should
// came out as "Sales moved Rs 15,000 more" (Template595, 2026-09-16). Naming
// the side removes the ambiguity for every kind of ledger.
function sideOf(difference: number): 'debit' | 'credit' {
  return difference > 0 ? 'debit' : 'credit';
}

function rupeesOf(amount: number): string {
  return `Rs ${Math.abs(Math.round(amount)).toLocaleString('en-IN')}`;
}

export function describeTieOutMismatches(mismatches: TieOutMismatch[]): string[] {
  const lines = mismatches.slice(0, MAX_TIE_OUT_MISMATCHES).map((mismatch) => {
    const rupees = rupeesOf(mismatch.difference);
    if (mismatch.status === 'missing') {
      return `${mismatch.account} does not appear in the Trial Balance export at all (it should have moved by ${rupees} this month)`;
    }
    return `${mismatch.account} shows ${rupees} more on the ${sideOf(mismatch.difference)} side in the Trial Balance than this month's correct postings`;
  });
  if (mismatches.length > MAX_TIE_OUT_MISMATCHES) {
    lines.push(`and ${mismatches.length - MAX_TIE_OUT_MISMATCHES} more ledger(s) in the Trial Balance are off`);
  }
  return lines;
}

// Extra vouchers, ledger set-up findings and accepted composite postings
// (2026-09-10), in plain words for the coaching call. Capped like the
// tie-out list so a broken export cannot flood the prompt.
const MAX_UNMATCHED_VOUCHERS = 6;

function formatTallyDate(date: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(date);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : date;
}

export function describeUnmatchedVouchers(vouchers: UnmatchedVoucher[]): string[] {
  const kindText: Record<UnmatchedVoucher['kind'], string> = {
    blank: 'a blank voucher with no ledger lines',
    duplicate: 'a duplicate of another voucher in the export',
    reversal: 'the exact reversal of another voucher in the export',
    extra: 'a posting that matches nothing in this batch',
  };
  const lines = vouchers.slice(0, MAX_UNMATCHED_VOUCHERS).map((voucher) => {
    const ledgers = voucher.ledgers.length > 0 ? `, ledgers ${voucher.ledgers.join(', ')}` : '';
    const amount = voucher.amount > 0 ? `, Rs ${Math.round(voucher.amount).toLocaleString('en-IN')}` : '';
    return `${voucher.voucher_type} voucher no. ${voucher.position} dated ${formatTallyDate(voucher.date)}${amount}${ledgers}: ${kindText[voucher.kind]}`;
  });
  if (vouchers.length > MAX_UNMATCHED_VOUCHERS) {
    lines.push(`and ${vouchers.length - MAX_UNMATCHED_VOUCHERS} more voucher(s) matched nothing`);
  }
  return lines;
}

// Books reconciliation lines (2026-09-10): closing balance per ledger
// against the correct books, year to date. Gap only, never the expected
// figure. Same cap as the tie-out list, and the same sign convention.
export function describeBooksReconciliation(differences: TieOutMismatch[]): string[] {
  const lines = differences.slice(0, MAX_TIE_OUT_MISMATCHES).map((difference) => {
    const rupees = rupeesOf(difference.difference);
    if (difference.status === 'missing') {
      return `${difference.account} has no ledger in the export although the correct books carry a balance of about ${rupees} on it`;
    }
    return `${difference.account} closes with ${rupees} more on the ${sideOf(difference.difference)} side than the correct books, year to date`;
  });
  if (differences.length > MAX_TIE_OUT_MISMATCHES) {
    lines.push(`and ${differences.length - MAX_TIE_OUT_MISMATCHES} more ledger(s) differ`);
  }
  return lines;
}

export function describeLedgerFindings(findings: LedgerFinding[]): string[] {
  return findings.map((finding) => {
    const names = finding.ledgers.join(', ');
    switch (finding.code) {
      case 'GST_LEDGER_NO_SIDE':
        return `GST ledger(s) named without an Input or Output side (${names}); the house practice keeps a separate Input and Output ledger for each head`;
      case 'SECOND_BANK_LEDGER':
        return `more than one bank ledger in use (${names}) for a company with a single bank account; every bank entry belongs in one ledger`;
      case 'DUPLICATE_PARTY_LEDGER':
        return `two ledgers for the same party (${names}); receipts and payments must go to the ledger the invoice used, or the bills never clear`;
    }
  });
}

export function describeCompositeMatches(composites: CompositeMatch[], sequenceLabels?: Map<number, string>): string[] {
  return composites.map((composite) => {
    const labels = composite.sequences.map((sequence) => sequenceLabels?.get(sequence) ?? `transaction ${sequence}`);
    return composite.kind === 'split'
      ? `${labels[0]} was posted as two vouchers whose combined ledger effect is right, and was accepted as such`
      : `${labels.join(' and ')} were posted as one combined voucher whose ledger effect is right, and were accepted as such`;
  });
}

// Plain-language buckets for each qualitative subscore — never a number, per
// the spec's "never raw subscores as numbers to the learner" rule. Coarse on
// purpose: the LLM turns these into natural prose, it doesn't need
// finer-grained input than "strong/mixed/weak" to do that well.
function qualitativeBucket(value: number): 'strong' | 'mixed' | 'weak' {
  return value >= 80 ? 'strong' : value >= 50 ? 'mixed' : 'weak';
}

function describeQualitativeSubscore(value: number, dimension: 'recall' | 'precision' | 'reasoning'): string {
  const bucket = qualitativeBucket(value);
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
    recallStrong: qualitativeBucket(qualitative.recall) === 'strong',
    precisionStrong: qualitativeBucket(qualitative.precision) === 'strong',
    reasoningStrong: qualitativeBucket(qualitative.reasoning_quality) === 'strong',
  };
}

// The closed fact ledger (2026-09-16): every statement the feedback may make,
// each with an id the model must cite. The texts are the description
// builders above, unchanged in substance, so the facts are exactly what the
// scoring engine found. Nothing outside this list may reach the learner:
// checkGrounding enforces it, and the fallback is built from it.
export function buildCoachingFacts(signal: CoachingSignal): CoachingFact[] {
  const entries: { kind: CoachingFactKind; text: string }[] = [];
  const add = (kind: CoachingFactKind, texts: readonly string[]) => {
    for (const text of texts) {
      entries.push({ kind, text });
    }
  };

  add('praise', signal.correctConceptDescriptions.map((area) => `${area} was handled correctly`));
  add('praise', signal.compositeDescriptions ?? []);
  if (signal.booksReconciliation?.clean) {
    add('praise', ["every ledger's closing balance agrees with the correct books year to date"]);
  }
  const qualitative = signal.qualitative;
  const qualitativeLines = qualitative
    ? [
        { strong: qualitative.recallStrong, text: qualitative.recallDescription },
        { strong: qualitative.precisionStrong, text: qualitative.precisionDescription },
        { strong: qualitative.reasoningStrong, text: qualitative.reasoningDescription },
      ]
    : [];
  add('praise', qualitativeLines.filter((line) => line.strong).map((line) => `in the written answer: ${line.text}`));
  add('fixed', signal.rectifications.filter((note) => note.classification === 'FIXED').map((note) => note.text));

  add('issue', signal.incorrectConceptDescriptions.map((area) =>
    /^entries that appear not to have been recorded/.test(area) ? area : `${area} needs another look`,
  ));
  add('issue', qualitativeLines.filter((line) => !line.strong).map((line) => `in the written answer: ${line.text}`));
  add('unmatched', signal.unmatchedVoucherDescriptions ?? []);
  add('ledger', signal.ledgerFindingDescriptions ?? []);
  if (signal.tbTieOut === false) {
    add('tieout', signal.tbMismatchDescriptions ?? []);
  }
  if (signal.booksReconciliation && !signal.booksReconciliation.clean) {
    // Drift framing only when there are earlier months (2026-09-16). It was
    // stated unconditionally, so a learner's first month was told the gap
    // "often traces back further than just this month".
    const hasEarlierMonths = (signal.batchOrdinal ?? 0) > 0;
    add(
      'books',
      signal.booksReconciliation.descriptions.map((line) =>
        hasEarlierMonths ? `${line} (a year-to-date gap can build up over earlier months as well as this one)` : line,
      ),
    );
  }
  add('still', signal.rectifications.filter((note) => note.classification === 'STILL_FAILING').map((note) => note.text));
  add('missing', signal.missingPartDescriptions);

  const counters = new Map<CoachingFactKind, number>();
  return entries.map((entry) => {
    const next = (counters.get(entry.kind) ?? 0) + 1;
    counters.set(entry.kind, next);
    return { id: `${FACT_ID_PREFIX[entry.kind]}${next}`, kind: entry.kind, text: entry.text };
  });
}

const PRAISE_KINDS: ReadonlySet<CoachingFactKind> = new Set(['praise', 'fixed']);
const ISSUE_KINDS: ReadonlySet<CoachingFactKind> = new Set(['issue', 'unmatched', 'ledger', 'tieout', 'books', 'still', 'missing']);
const HISTORY_KINDS: ReadonlySet<CoachingFactKind> = new Set(['fixed', 'still']);

export type CoachingDeps = {
  complete: (params: TracedCompletionParams) => Promise<unknown>;
  recordViolations: typeof recordCoachingGroundingViolations;
};

// Generates one combined feedback message covering whichever of quantitative
// (Tally posting) and qualitative (free-text answer) scoring applied to this
// exercise — a direct-entry exercise passes only scoringResult, a review
// exercise passes only qualitative, an explain exercise passes both and gets
// one feedback message weaving in both signals, per the spec's "combine...
// into the exercise's overall result" instruction and Unit 06's existing
// single-feedback-bubble UI.
//
// Grounded (2026-09-16): the model phrases the fact ledger and cites it,
// checkGrounding verifies every bullet in code, violations are fed back for
// a retry, and after MAX_ATTEMPTS the feedback is composed from the facts in
// code. next_note is always composed in code from the correction decision.
// The stored shape is unchanged: fact ids are stripped here.
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
    rectifications?: RectificationNote[];
    // Position of the batch in the learner's timeline (0 = first month).
    batchOrdinal?: number | null;
    // What happens after this feedback, decided by the same pure rule
    // openCorrectionRoundOrAdvance applies (correction-round.ts).
    nextStep: CorrectionDecision;
  },
  deps?: Partial<CoachingDeps>,
): Promise<Coaching> {
  const complete = deps?.complete ?? getTracedStructuredCompletion;
  const recordViolations = deps?.recordViolations ?? recordCoachingGroundingViolations;

  const baseSignal: CoachingSignal = params.scoringResult
    ? buildCoachingSignal(params.scoringResult, params.answerKey)
    : {
        overallResult: params.overallResult,
        tbTieOut: null,
        incorrectConceptDescriptions: [],
        correctConceptDescriptions: [],
        qualitative: null,
        missingPartDescriptions: [],
        rectifications: [],
      };

  const signal: CoachingSignal = {
    ...baseSignal,
    overallResult: params.overallResult,
    qualitative: params.qualitative ? buildQualitativeCoachingSignal(params.qualitative) : null,
    missingPartDescriptions: params.missingPartDescriptions ?? [],
    rectifications: params.rectifications ?? [],
    batchOrdinal: params.batchOrdinal ?? null,
  };
  const facts = buildCoachingFacts(signal);
  const nextNote = composeNextNote({
    nextStep: params.nextStep,
    missingPartDescriptions: signal.missingPartDescriptions,
    hasFindings: facts.some((fact) => ISSUE_KINDS.has(fact.kind)),
  });

  let violations: string[] = [];
  let previousOutput: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { messages, jsonSchema } =
      attempt === 1
        ? buildCoachingPrompt(signal, facts)
        : buildCoachingRetryPrompt(signal, facts, violations, previousOutput);

    let raw: unknown;
    try {
      raw = await complete({
        messages,
        jsonSchema,
        traceName: 'coaching',
        learnerId,
        callType: 'coaching',
        temperature: COACHING_TEMPERATURE,
        extraMetadata: { attempt, factCount: facts.length, ...(attempt > 1 ? { previousViolations: violations } : {}) },
      });
    } catch (error) {
      // Malformed JSON from the model is one more failed attempt, so it ends
      // in the fact-built fallback like any other bad output (review finding,
      // 2026-09-16). Anything else (network, auth, 4xx) still throws and
      // Inngest retries the step.
      if (!(error instanceof SyntaxError)) throw error;
      violations = [`The response was not valid JSON: ${error.message}`];
      previousOutput = null;
      recordViolations({ learnerId, attempt, violations, usedFallback: attempt === MAX_ATTEMPTS });
      continue;
    }
    previousOutput = raw;

    const parsed = CoachingModelOutputSchema.safeParse(raw);
    violations = parsed.success
      ? checkGrounding(parsed.data, facts, { tbTieOut: signal.tbTieOut })
      : [`The response did not match the schema: ${parsed.error.message}`];

    if (parsed.success && violations.length === 0) {
      return toStoredCoaching(parsed.data, nextNote);
    }

    recordViolations({ learnerId, attempt, violations, usedFallback: attempt === MAX_ATTEMPTS });
  }

  // Deterministic fallback rather than ungrounded text or a thrown step: a
  // throw would re-run the same model through Inngest's retries and could
  // end with the submission marked failed. The fallback states every
  // finding, in the engine's own words.
  return { ...composeFallbackCoaching(facts, signal), next_note: nextNote };
}

function toStoredCoaching(output: CoachingModelOutput, nextNote: string): Coaching {
  return {
    opening_line: output.opening_line.trim(),
    went_well: output.went_well.map((bullet) => bullet.text.trim()),
    needs_work: output.needs_work.map((bullet) => bullet.text.trim()),
    next_note: nextNote,
  };
}

// Identifier-like tokens: uppercase-led hyphenated references as they appear
// in the signal's labels — DT-115, INV-016, INV-M-101, CA26-101, AI-201.
const FEEDBACK_IDENTIFIER_PATTERN = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g;

// Any figure: 15,000 / 1,50,000 (Indian grouping) / 720.34 / 12-04-2025's
// parts. Compared after removing grouping commas and leading zeros, so
// "Rs 15,000" in a fact and "Rs 15000" in a bullet agree.
const NUMBER_PATTERN = /\d[\d,]*(?:\.\d+)?/g;

// Phrases that claim history. Allowed only where the cited facts carry
// history themselves (see checkGrounding).
//
// Phrases, not bare words (2026-09-16, live replay): "look again", "check
// before posting" and "still needs a look" are ordinary coaching, and banning
// the bare words sent two of three attempts on Template595's pack back for a
// retry. What must never slip through is every form the invented history on
// that learner's first review took: "flagged in an earlier round", "still
// recurring", "two rounds running", "showed up as a gap before too", "same
// classification gap flagged", "same as last time".
const HISTORY_PATTERN = new RegExp(
  [
    String.raw`recurr\w*`,
    String.raw`rounds? running`,
    String.raw`(?:earlier|previous|prior|last|past|other) (?:rounds?|batch(?:es)?|months?|attempts?|submissions?|exercises?|weeks?|time)`,
    String.raw`(?:as|like|from|than) (?:before|last time)`,
    String.raw`before (?:too|as well)`,
    String.raw`(?:flagged|seen|noted|raised|pointed out|mentioned|caught|called out) (?:\w+ )?(?:before|earlier|previously|last time|again)`,
    String.raw`(?:come|came|comes|shown|showed|shows|turned|turns|cropped|crops) up (?:\w+ ){0,4}?(?:before|earlier|previously|again)`,
    String.raw`(?:still|again) (?:failing|wrong|slipping|recurring|showing up|an issue|a problem|a gap|off)`,
    String.raw`(?:failed|slipped|went wrong|missed|repeated|happened|occurred) (?:\w+ )?again`,
    String.raw`(?:once|yet) again`,
    String.raw`previously`,
    String.raw`no longer`,
    String.raw`same (?:\w+ )?(?:gap|issue|mistake|problem|error|slip|weakness) (?:as|from|flagged|seen|noted|again|before|that (?:came|showed|was))`,
  ]
    .map((phrase) => String.raw`\b${phrase}\b`)
    .join('|'),
  'i',
);

const EM_DASH = '—';

function numbersIn(text: string): string[] {
  return (text.match(NUMBER_PATTERN) ?? [])
    .map((token) => token.replace(/,/g, ''))
    .filter((token) => token.length > 0)
    .map((token) => String(Number(token)));
}

function identifiersIn(text: string): string[] {
  return text.match(FEEDBACK_IDENTIFIER_PATTERN) ?? [];
}

// The ledger a Trial Balance or books fact is about: the words before its
// verb ("Sales shows…", "Purchase Returns has no ledger…").
const LEDGER_FACT_SUBJECT = /^(.+?) (?:shows|closes|does not appear|has no ledger)\b/i;

function ledgerSubjectOf(fact: CoachingFact): string | null {
  if (fact.kind !== 'tieout' && fact.kind !== 'books') return null;
  const match = LEDGER_FACT_SUBJECT.exec(fact.text);
  return match ? match[1].trim().toLowerCase() : null;
}

// Clauses of a bullet: sentences, semicolons, colons, and "and"/"while"/
// "with" joins, which is where a model merging several ledgers puts the seam.
function clausesOf(text: string): string[] {
  return text
    .split(/[.;:]\s+|,?\s+\b(?:and|while|with|whereas|but)\b\s+/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function mentions(clause: string, subject: string): boolean {
  const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(clause);
}

// Figures swapped between merged ledger facts (review finding, 2026-09-16).
// The pooled check only asks whether a figure appears in ANY cited fact, so
// "Sales is off by Rs 8,000 and Purchases by Rs 15,000" passed when the
// facts said the reverse. Here, a clause that names a cited ledger may only
// carry that ledger's figures. When a clause names a ledger and also a longer
// ledger containing it ("Sales" inside "Sales Returns"), only the longer one
// counts, so the two cannot lend each other figures.
function misattributedFigures(bulletText: string, citedFacts: CoachingFact[]): string[] {
  const ledgerFacts = citedFacts
    .map((fact) => ({ fact, subject: ledgerSubjectOf(fact) }))
    .filter((entry): entry is { fact: CoachingFact; subject: string } => entry.subject !== null);
  if (ledgerFacts.length < 2) return [];

  const problems: string[] = [];
  for (const clause of clausesOf(bulletText)) {
    const figures = numbersIn(clause);
    if (figures.length === 0) continue;
    const named = ledgerFacts.filter((entry) => mentions(clause, entry.subject));
    const owners = named.filter(
      (entry) => !named.some((other) => other.subject.length > entry.subject.length && other.subject.includes(entry.subject)),
    );
    if (owners.length === 0) continue;
    const ownFigures = new Set(owners.flatMap((entry) => numbersIn(entry.fact.text)));
    const stray = figures.filter((figure) => !ownFigures.has(figure));
    if (stray.length > 0) {
      problems.push(`${stray.join(', ')} next to ${owners.map((entry) => entry.subject).join(' / ')}`);
    }
  }
  return problems;
}

export type GroundingContext = { tbTieOut: boolean | null };

// The citation contract, checked in code (2026-09-16). Returns every
// violation found, each phrased so it can be handed straight back to the
// model; an empty list means the output is grounded. Pure and exported for
// tests. The rules:
//  - every bullet cites at least one listed fact; went_well cites only
//    praise/fixed facts, needs_work only issue-type facts;
//  - every identifier and every number in a bullet occurs in the text of the
//    facts that bullet cites;
//  - history words only in a bullet citing a fixed/still fact (or a fact
//    whose own text uses history words); in opening_line only when a
//    fixed/still fact exists;
//  - every issue-type fact is cited at least once, so no finding is dropped;
//  - opening_line keeps the score/verdict/Trial Balance rules and carries no
//    numbers or identifiers;
//  - no em dash anywhere.
export function checkGrounding(
  output: CoachingModelOutput,
  facts: CoachingFact[],
  context: GroundingContext,
): string[] {
  const violations: string[] = [];
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const cited = new Set<string>();
  const hasHistoryFacts = facts.some((fact) => HISTORY_KINDS.has(fact.kind));

  const sections = [
    { name: 'went_well', bullets: output.went_well, allowed: PRAISE_KINDS },
    { name: 'needs_work', bullets: output.needs_work, allowed: ISSUE_KINDS },
  ] as const;

  for (const section of sections) {
    section.bullets.forEach((bullet, index) => {
      const where = `${section.name} bullet ${index + 1} ("${bullet.text.slice(0, 60)}")`;
      const citedFacts: CoachingFact[] = [];
      if (bullet.fact_ids.length === 0) {
        violations.push(`${where} cites no fact ids. Every bullet must cite the facts it restates.`);
      }
      for (const id of bullet.fact_ids) {
        const fact = factsById.get(id);
        if (!fact) {
          violations.push(`${where} cites "${id}", which is not a listed fact.`);
          continue;
        }
        if (!section.allowed.has(fact.kind)) {
          violations.push(
            section.name === 'went_well'
              ? `${where} cites ${id}, a ${fact.kind} fact. went_well may cite only P and F facts.`
              : `${where} cites ${id}, a ${fact.kind} fact. needs_work may not cite P or F facts.`,
          );
        }
        cited.add(id);
        citedFacts.push(fact);
      }

      const sourceText = citedFacts.map((fact) => fact.text).join(' ');
      const allowedIdentifiers = new Set(identifiersIn(sourceText));
      const unknownIdentifiers = [...new Set(identifiersIn(bullet.text).filter((id) => !allowedIdentifiers.has(id)))];
      if (unknownIdentifiers.length > 0) {
        violations.push(
          `${where} mentions ${unknownIdentifiers.join(', ')}, not written in the facts it cites. Copy identifiers exactly from a cited fact, never retype or invent one.`,
        );
      }

      const allowedNumbers = new Set(numbersIn(sourceText));
      const unknownNumbers = [...new Set(numbersIn(bullet.text).filter((number) => !allowedNumbers.has(number)))];
      if (unknownNumbers.length > 0) {
        violations.push(
          `${where} states the number(s) ${unknownNumbers.join(', ')}, not written in the facts it cites. Use only figures copied from a cited fact.`,
        );
      }
      const misattributed = misattributedFigures(bullet.text, citedFacts);
      if (misattributed.length > 0) {
        violations.push(
          `${where} puts a figure against the wrong ledger (${misattributed.join('; ')}). Each ledger's figure must come from that ledger's own fact.`,
        );
      }

      const historyMatch = HISTORY_PATTERN.exec(bullet.text);
      const historyAllowed = citedFacts.some((fact) => HISTORY_KINDS.has(fact.kind) || HISTORY_PATTERN.test(fact.text));
      if (historyMatch && !historyAllowed) {
        violations.push(
          `${where} uses "${historyMatch[0]}", which claims history no cited fact supports. Remove any reference to earlier attempts.`,
        );
      }

      if (bullet.text.includes(EM_DASH)) {
        violations.push(`${where} contains an em dash. Use a colon, a comma or a full stop.`);
      }
    });
  }

  const uncited = facts.filter((fact) => ISSUE_KINDS.has(fact.kind) && !cited.has(fact.id));
  if (uncited.length > 0) {
    violations.push(
      `These findings are not cited by any needs_work bullet: ${uncited.map((fact) => fact.id).join(', ')}. Every I, U, L, T, B, S and M fact must be covered.`,
    );
  }

  const openingIssue = checkOpeningLineFacts(output.opening_line, context);
  if (openingIssue !== null) {
    violations.push(openingIssue);
  }
  if (numbersIn(output.opening_line).length > 0 || identifiersIn(output.opening_line).length > 0) {
    violations.push('Your opening_line contains a number or an identifier. It cites no fact, so it must contain neither.');
  }
  const openingHistory = HISTORY_PATTERN.exec(output.opening_line);
  if (openingHistory && !hasHistoryFacts) {
    violations.push(
      `Your opening_line uses "${openingHistory[0]}", but there are no F or S facts. Say nothing about earlier attempts.`,
    );
  }
  if (output.opening_line.includes(EM_DASH)) {
    violations.push('Your opening_line contains an em dash. Use a colon, a comma or a full stop.');
  }

  return violations;
}

// A percentage, a mark, or the word "score" in the opening line (2026-09-16).
// Learners no longer see a number for a batch, and prompt instruction alone
// has never been reliable on this file's other guards, which is why they are
// all enforced in code here.
const SCORE_LANGUAGE_PATTERN = /\d\s*(?:%|percent\b)|\bscored?\b|\bscores\b|\bout of \d/i;

// Verdict words in the opening line. "partial" and the fail family are banned
// outright. "pass" is NOT: passing an entry is ordinary Indian accounting
// usage ("you passed the journal correctly") and banning it would send clean
// feedback into a pointless retry, so only its verdict shapes are caught.
const VERDICT_LANGUAGE_PATTERN = /\bpartial(?:ly)?\b|\bfail(?:s|ed|ure|ing)?\b|\bpasses\b|\b(?:did|does|do)\s+not\s+pass\b|\bnot a pass\b/i;

// Returns a retry-feedback message when opening_line contradicts the computed
// scoring facts or reaches for score/verdict language, null when it's clean.
// Exported for tests.
export function checkOpeningLineFacts(openingLine: string, signal: Pick<CoachingSignal, 'tbTieOut'>): string | null {
  if (signal.tbTieOut === true && /trial\s*balance/i.test(openingLine)) {
    return 'Your opening_line attributes the result to the Trial Balance, but the Trial Balance tie-out MATCHED. Restate the opening_line without mentioning the Trial Balance.';
  }
  if (SCORE_LANGUAGE_PATTERN.test(openingLine)) {
    return 'Your opening_line states a score, a percentage or a mark. Learners are never shown one. Restate it saying what the batch showed, with no numbers about performance.';
  }
  if (VERDICT_LANGUAGE_PATTERN.test(openingLine)) {
    return 'Your opening_line uses a verdict word ("partial", "fail", "passes"). Learners are never given a verdict. Restate it saying what went right and what the sections below cover.';
  }
  return null;
}

// Deterministic opening line used only when the model repeatedly produces a
// factually-wrong one: plain and safe rather than clever, no score, no
// verdict, no em dashes (learner-facing hard rule). These three lines must
// themselves survive checkOpeningLineFacts, since they are what replaces a
// line that failed it.
export function composeFallbackOpeningLine(signal: Pick<CoachingSignal, 'overallResult'>): string {
  if (signal.overallResult === 'pass') {
    return 'This batch came out clean. Here is what you got right.';
  }
  if (signal.overallResult === 'partial') {
    return 'Good work on a lot of this. Some entries are right, and a few areas below are worth another look.';
  }
  return 'There is real ground to cover in this one. The areas below are where to start.';
}

function asSentence(text: string): string {
  const trimmed = text.trim();
  const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

// The feedback composed from the facts alone (2026-09-16), used when the
// model cannot produce grounded output in MAX_ATTEMPTS. Plainer than the
// model's prose, but every praise fact is in went_well and EVERY finding is
// in needs_work: the old fallback kept only the concept areas and silently
// dropped extra vouchers, ledger findings, Trial Balance and books gaps,
// rectifications and missing parts. It passes checkGrounding by construction
// (each bullet is its own fact's text).
export function composeFallbackCoaching(
  facts: CoachingFact[],
  signal: Pick<CoachingSignal, 'overallResult'>,
): Omit<Coaching, 'next_note'> {
  return {
    opening_line: composeFallbackOpeningLine(signal),
    went_well: facts.filter((fact) => PRAISE_KINDS.has(fact.kind)).map((fact) => asSentence(fact.text)),
    needs_work: facts.filter((fact) => ISSUE_KINDS.has(fact.kind)).map((fact) => asSentence(fact.text)),
  };
}

// The closing line, written in code from what will actually happen next
// (2026-09-16). The model wrote it blind and told Template595 there was
// "nothing more to send" in the same run that opened a correction round
// asking for corrected exports.
//
// An open round is followed in the chat by the pushed help step and then
// correctionInviteLine ("...send me the corrected Day Book and Trial
// Balance"), so this line does not repeat the send instruction. It also stays
// true in the one case the decision is overridden: openCorrectionRoundOrAdvance
// advances instead when the help step cannot be generated, and then what
// follows is the next batch, which "the next steps follow below" still
// describes. Likewise "what comes next" rather than "your next batch" on the
// advance side, because generateNextExercise can find every concept mastered
// or a batch already generated.
export function composeNextNote(params: {
  nextStep: CorrectionDecision;
  missingPartDescriptions: readonly string[];
  hasFindings: boolean;
}): string {
  const missing = params.missingPartDescriptions.map(asSentence);
  const step =
    params.nextStep.kind === 'open'
      ? params.hasFindings
        ? 'Fix these points in Tally first. The next steps follow below.'
        : 'The next steps follow below.'
      : params.hasFindings
        ? 'Keep these points in mind as you move on. What comes next follows below.'
        : 'Nothing here needs fixing. What comes next follows below.';
  return [...missing, step].join(' ');
}
