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
import {
  containsPhrase,
  dashViolation,
  numbersIn,
  phrasePositions,
  referencesIn,
  sanitizeLearnerText,
} from '@/lib/tutor/grounded-prose';

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

// The side of a voucher that carries the PARTY (customer or supplier) for the
// voucher types where that side is unambiguous. Payments, receipts and
// journals are not listed: their non-bank leg is as often an expense or
// income ledger (the answer) as it is a party.
const PARTY_SIDE_BY_VOUCHER_TYPE: Record<string, 'Dr' | 'Cr'> = {
  sales: 'Dr',
  purchase: 'Cr',
  'credit note': 'Cr',
  'debit note': 'Dr',
};

function rupees(amount: number): string {
  return `Rs ${Math.abs(Math.round(amount)).toLocaleString('en-IN')}`;
}

// Human identifiers per answer-key sequence: the bill/invoice reference when
// one exists ("INV-012"), the party the voucher is with, or the voucher's
// amount. Bare sequence numbers mean nothing to a learner working a pack
// exercise - the transactions live in files, not a numbered chat list - and
// feedback that says "transaction 43" reads as noise (observed live
// 2026-08-24: coaching went fully generic because the signal gave the model
// nothing nameable).
//
// Invariant 1 (2026-09-17): a label names only what the learner's own source
// documents show, the bill reference, the party on a sales or purchase
// voucher and the voucher total. It used to fall back to the first
// non-generic leg, which on a direct expense ("Dr Advertisement & Marketing,
// Cr Bank") is the ledger the learner is being scored on choosing, so the
// feedback named the correct account before a correction round resubmitted
// against the same key.
export function buildSequenceLabels(answerKey: AnswerKey): Map<number, string> {
  const labels = new Map<number, string>();
  const bySequence = new Map<number, typeof answerKey.entries>();
  for (const entry of answerKey.entries) {
    const group = bySequence.get(entry.sequence) ?? [];
    group.push(entry);
    bySequence.set(entry.sequence, group);
  }
  const totalOf = (legs: typeof answerKey.entries) => Math.max(...legs.map((leg) => Math.abs(leg.amount)));

  for (const [sequence, legs] of bySequence) {
    const voucherWord = legs[0].voucher_type.trim().toLowerCase();
    const partySide = PARTY_SIDE_BY_VOUCHER_TYPE[voucherWord];
    const partyLegs = partySide ? legs.filter((leg) => leg.dr_cr === partySide) : [];
    const partyLeg = partyLegs.reduce<(typeof legs)[number] | null>(
      (largest, leg) => (largest === null || Math.abs(leg.amount) > Math.abs(largest.amount) ? leg : largest),
      null,
    );
    const party =
      partyLeg && !GENERIC_ACCOUNT_PATTERN.test(partyLeg.correct_account) ? sanitizeLearnerText(partyLeg.correct_account) : null;
    const billRef = legs.find((leg) => leg.bill_reference)?.bill_reference;
    const rider = party ? `the ${party} ${voucherWord}` : `the ${rupees(totalOf(legs))} ${voucherWord}`;
    // Bill references come from the SOURCE PACK, not the learner's books, so
    // a learner who never entered the Against Ref cannot find "INV-M-101" in
    // their Tally (first real intern, 2026-08-31). The rider locates it.
    labels.set(sequence, billRef ? `${billRef} (${rider})` : rider);
  }

  // Collision guardrail (2026-09-01): two different transactions can produce
  // the same label — praise for one and a flag for the other then read as
  // the tool contradicting itself. The amount goes on first (a fact from the
  // learner's own source documents); if that still collides, the sequence.
  const disambiguate = (suffixOf: (sequence: number, label: string) => string | null) => {
    const sequencesByLabel = new Map<string, number[]>();
    for (const [sequence, label] of labels) {
      sequencesByLabel.set(label, [...(sequencesByLabel.get(label) ?? []), sequence]);
    }
    for (const [label, sequences] of sequencesByLabel) {
      if (sequences.length < 2) continue;
      for (const sequence of sequences) {
        const suffix = suffixOf(sequence, label);
        if (suffix) labels.set(sequence, `${label}${suffix}`);
      }
    }
  };
  disambiguate((sequence, label) => {
    const legs = bySequence.get(sequence);
    const amount = legs ? rupees(totalOf(legs)) : null;
    return amount && !label.includes(amount) ? ` of ${amount}` : null;
  });
  disambiguate((sequence) => `, transaction ${sequence}`);
  return labels;
}

function joinNames(names: string[]): string {
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
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
    // "on" rather than wrapping the labels in parentheses (2026-09-17): the
    // labels carry their own "(the X sales)" rider, and the fallback printed
    // "(INV-012 (the X sales))" to learners.
    const names = [...new Set(sorted.map((ref) => sequenceLabels?.get(ref) ?? `transaction ${ref}`))];
    return `${label} on ${joinNames(names)}`;
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
    missingDescriptions.push(`entries that appear not to have been recorded in the Day Book at all: ${joinNames(names)}`);
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
// (2026-09-09, movement-based tie-out). Capped so a badly exported Trial
// Balance does not flood the prompt; the cap is stated as its own line,
// never silent.
const MAX_TIE_OUT_MISMATCHES = 6;

// The difference is Dr-positive (learner's signed movement minus the correct
// one). It used to be rendered as "moved by Rs X more/less", which reads
// backwards for a credit ledger: Sales carrying LESS credit than it should
// came out as "Sales moved Rs 15,000 more" (Template595, 2026-09-16). Naming
// the side removes the ambiguity for every kind of ledger.
function sideOf(difference: number): 'debit' | 'credit' {
  return difference > 0 ? 'debit' : 'credit';
}

// Invariant 1 (2026-09-17): a ledger MISSING from the export has no figure of
// the learner's own, so its "difference" is the correct movement itself.
// Printing it ("it should have moved by Rs 5,000") handed over the answer key
// ahead of a correction-round resubmission against the same key. A missing
// ledger is now stated without a figure.
export function describeTieOutMismatches(mismatches: TieOutMismatch[]): string[] {
  const lines = mismatches.slice(0, MAX_TIE_OUT_MISMATCHES).map((mismatch) => {
    const account = sanitizeLearnerText(mismatch.account);
    if (mismatch.status === 'missing') {
      return `${account} does not appear in the Trial Balance export at all, although this month's postings should move it`;
    }
    return `${account} shows ${rupees(mismatch.difference)} more on the ${sideOf(mismatch.difference)} side in the Trial Balance than this month's correct postings`;
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
  return match ? `${match[3]}-${match[2]}-${match[1]}` : sanitizeLearnerText(date, 20);
}

// Ledger and voucher-type names here are typed by the learner in Tally
// (2026-09-17): they are sanitized (control characters, quote/bracket
// characters, dashes, length) before they become fact text, because fact
// text goes into the prompt and, verbatim, into the fallback review.
export function describeUnmatchedVouchers(vouchers: UnmatchedVoucher[]): string[] {
  const kindText: Record<UnmatchedVoucher['kind'], string> = {
    blank: 'a blank voucher with no ledger lines',
    duplicate: 'a duplicate of another voucher in the export',
    reversal: 'the exact reversal of another voucher in the export',
    extra: 'a posting that matches nothing in this batch',
  };
  const lines = vouchers.slice(0, MAX_UNMATCHED_VOUCHERS).map((voucher) => {
    const names = voucher.ledgers.map((ledger) => sanitizeLearnerText(ledger)).filter((ledger) => ledger.length > 0);
    const ledgers = names.length > 0 ? `, ledgers ${names.join(', ')}` : '';
    const amount = voucher.amount > 0 ? `, Rs ${Math.round(voucher.amount).toLocaleString('en-IN')}` : '';
    return `${sanitizeLearnerText(voucher.voucher_type, 30)} voucher no. ${voucher.position} dated ${formatTallyDate(voucher.date)}${amount}${ledgers}: ${kindText[voucher.kind]}`;
  });
  if (vouchers.length > MAX_UNMATCHED_VOUCHERS) {
    lines.push(`and ${vouchers.length - MAX_UNMATCHED_VOUCHERS} more voucher(s) matched nothing`);
  }
  return lines;
}

// Books reconciliation lines (2026-09-10): closing balance per ledger
// against the correct books, year to date. Same cap and sign convention as
// the tie-out list.
//
// Direction only (2026-09-17, invariant 1): the gap in rupees, read against
// the learner's own closing balance, IS the correct books' figure, and a
// missing ledger's figure is the correct balance outright. Both were printed
// before a correction round resubmitted against the same key.
export function describeBooksReconciliation(differences: TieOutMismatch[]): string[] {
  const lines = differences.slice(0, MAX_TIE_OUT_MISMATCHES).map((difference) => {
    const account = sanitizeLearnerText(difference.account);
    if (difference.status === 'missing') {
      return `${account} has no ledger in the export although the correct books carry a balance on it`;
    }
    return `${account} closes heavier on the ${sideOf(difference.difference)} side than the correct books, year to date`;
  });
  if (differences.length > MAX_TIE_OUT_MISMATCHES) {
    lines.push(`and ${differences.length - MAX_TIE_OUT_MISMATCHES} more ledger(s) differ`);
  }
  return lines;
}

export function describeLedgerFindings(findings: LedgerFinding[]): string[] {
  return findings.map((finding) => {
    const names = finding.ledgers.map((ledger) => sanitizeLearnerText(ledger)).join(', ');
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
// finer-grained input than "strong/mixed/weak" to do that well. The grader's
// own rationale never reaches a fact (2026-09-17): only these code-written
// rubric lines do.
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

export function buildQualitativeCoachingSignal(qualitative: QualitativeScoring): QualitativeCoachingSignal {
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

// Every ledger or party name the feedback could plausibly name (2026-09-17):
// the answer key's accounts and aliases, and every ledger the learner's own
// export put into a finding. checkGrounding rejects a bullet naming one of
// these that its cited facts do not name, which is how "the Mumbai Suppliers
// invoice" on a Karnataka Emporium finding is caught.
export function collectKnownNames(answerKey: AnswerKey | null | undefined, scoringResult: ScoringResult | null): string[] {
  const names = new Set<string>();
  const add = (name: string) => {
    const clean = sanitizeLearnerText(name);
    if (clean.length >= 3) names.add(clean);
  };
  for (const entry of answerKey?.entries ?? []) {
    add(entry.correct_account);
    for (const alias of entry.account_aliases ?? []) add(alias);
  }
  for (const voucher of scoringResult?.unmatched_vouchers ?? []) voucher.ledgers.forEach(add);
  for (const finding of scoringResult?.ledger_findings ?? []) finding.ledgers.forEach(add);
  for (const mismatch of scoringResult?.tb_tie_out_mismatches ?? []) add(mismatch.account);
  for (const difference of scoringResult?.books_reconciliation ?? []) add(difference.account);
  return [...names];
}

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
  const knownNames = collectKnownNames(params.answerKey, params.scoringResult);
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
      ? checkGrounding(parsed.data, facts, { tbTieOut: signal.tbTieOut, knownNames })
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
// in the signal's labels — DT-115, INV-016, INV-M-101, CA26-101, AI-201 —
// plus any-case references carrying a digit (2026-09-17: "inv-099" slipped
// past the uppercase-only pattern). Compared case-insensitively.
const FEEDBACK_IDENTIFIER_PATTERN = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g;

function identifiersIn(text: string): string[] {
  return [...new Set([...(text.match(FEEDBACK_IDENTIFIER_PATTERN) ?? []), ...referencesIn(text)])];
}

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
//
// Widened 2026-09-17 with every history phrase the grounding audit got past
// the old list: "keep making", "keeps happening", "continues to", "second
// time", "persists", "remains wrong", "still has not been fixed", "like your
// April batch", "first review", "yet another", "from the last review",
// "previous one", "habit". "the second transaction" stays ordinary.
const MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December';
const HISTORY_PATTERN = new RegExp(
  [
    String.raw`recurr\w*`,
    String.raw`rounds? running`,
    String.raw`(?:earlier|previous|prior|last|past|other) (?:rounds?|batch(?:es)?|months?|attempts?|submissions?|exercises?|weeks?|time)`,
    String.raw`(?:earlier|previous|prior|last|past) (?:reviews?|feedback|one)`,
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
    String.raw`(?:keeps?|kept|keeping) (?:on )?(?:making|happening|slipping|getting|missing|posting|using|coming|showing|repeating|forgetting|mixing)`,
    String.raw`continu(?:e|es|ed|ing) to`,
    String.raw`(?:second|third|fourth|fifth|another) time`,
    String.raw`persist(?:s|ed|ent|ently|ing|ence)?`,
    String.raw`remain(?:s|ed|ing)? (?:wrong|off|missing|unfixed|uncorrected|incorrect|unresolved|an issue|a problem|a gap)`,
    String.raw`(?:still|yet) (?:has|have|had|is|are) (?:not|n't)`,
    String.raw`(?:has|have) still not`,
    String.raw`not (?:been )?(?:fixed|corrected) yet`,
    String.raw`yet another`,
    String.raw`first (?:review|feedback)`,
    String.raw`(?:like|as in|as with|from|since|than) your (?:\w+ )?(?:batch|review|submission|attempt|round|month)`,
    String.raw`habit(?:s|ual|ually)?`,
    String.raw`(?:your|the|in|from|since|like) (?:${MONTH_NAMES})(?:'s)? (?:batch|review|submission|attempt|feedback|round)`,
  ]
    .map((phrase) => String.raw`\b${phrase}\b`)
    .join('|'),
  'i',
);

// Spelled-out figures of ten and above (2026-09-17): "fifteen thousand
// rupees" carried a number no digit check could see.
const SPELLED_NUMBER_PATTERN =
  /\b(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakhs?|crores?|million|billion)\b/i;

// Dates written in words ("the fifth of June").
const WORD_ORDINAL =
  'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty-\\w+|thirtieth|thirty-first';
const WORDED_DATE_PATTERN = new RegExp(
  String.raw`\b(?:${WORD_ORDINAL})\s+(?:day\s+)?of\s+(?:${MONTH_NAMES})\b|\b(?:${MONTH_NAMES})\s+(?:the\s+)?(?:${WORD_ORDINAL})\b`,
  'i',
);

// A bullet that merges figures from several facts and then assigns them by
// "respectively" cannot be attributed clause by clause, so it is refused.
const RESPECTIVELY_PATTERN = /\brespectively\b/i;

// Praise wording in a needs_work bullet flips the finding's polarity ("Sales
// in the Trial Balance is actually fine").
const NEEDS_WORK_PRAISE_PATTERN =
  /\b(?:is|are|was|were|looks?|seems?|came out|comes out)\s+(?:(?:actually|all|already|now|really|perfectly|entirely|fully|completely|totally|quite)\s+)?(?:fine|correct|right|clean|ok(?:ay)?|accurate|good|perfect|in order)\b|\bfine\b|\bclean\b(?!\s+up)|\bno (?:issues?|problems?|errors?|mistakes?)\b|\bnothing (?:wrong|to fix)\b|\bspot on\b|\bflawless\b|\bperfect(?:ly)?\b|\bhandled (?:correctly|well)\b|\bgot (?:it )?right\b/i;

// Claims of totality. In went_well and the opening line they are only true
// when nothing was flagged (2026-09-17 audit: "Every entry in the batch was
// handled correctly" above three findings).
const OVERCLAIM_PATTERN =
  /\b(?:all|every|each)\b(?:\s+[\w']+){0,3}?\s+(?:entr(?:y|ies)|transactions?|vouchers?|ledgers?|postings?|bills?|invoices?|lines?|thing)\b|\beverything\b|\bperfect(?:ly)?\b|\bclean(?:ly)?\b(?!\s+up)|\bno (?:errors?|mistakes?|issues?)\b|\bnothing to fix\b|\bflawless(?:ly)?\b|\bwithout (?:a single |any )?(?:error|mistake)s?\b/i;

// Concept words a bullet may only use when a cited fact is about that
// concept (2026-09-17 audit: "the TDS on INV-012" on an account
// classification finding). `said` is the looser form used to check that a
// cited fact is actually stated.
type ConceptFamily = { name: string; bullet: RegExp; support: (fact: CoachingFact) => boolean; said: RegExp };
const CONCEPT_FAMILIES: ConceptFamily[] = [
  {
    name: 'GST',
    bullet: /\b(?:GST|IGST|CGST|SGST|UTGST|ITC|input tax credit)\b/i,
    support: (fact) => /\b(?:GST|IGST|CGST|SGST|UTGST|ITC|input tax credit)\b/i.test(fact.text),
    said: /\b(?:GST|IGST|CGST|SGST|UTGST|ITC|tax)\b/i,
  },
  {
    name: 'TDS',
    bullet: /\bTDS\b|\b19[2-6][A-Z]{1,2}\b/,
    support: (fact) => /\bTDS\b/i.test(fact.text),
    said: /\bTDS\b/i,
  },
  {
    name: 'bill-by-bill referencing',
    bullet: /\bbill[- ]by[- ]bill\b|\bbill ref(?:erence)?s?\b|\bagainst ref\b|\bnew ref\b/i,
    support: (fact) => /\bbill[- ]by[- ]bill\b|\bbill ref(?:erence)?s?\b|\bagainst ref\b|\bbills\b/i.test(fact.text),
    said: /\bbills?\b|\bref(?:erence)?s?\b/i,
  },
  {
    name: 'narration',
    bullet: /\bnarrations?\b/i,
    support: (fact) => /\bnarrations?\b/i.test(fact.text),
    said: /\bnarrations?\b/i,
  },
  {
    name: 'voucher type',
    bullet: /\bvoucher types?\b/i,
    support: (fact) => /\bvoucher types?\b/i.test(fact.text),
    said: /\bvoucher types?\b|\bvoucher\b/i,
  },
  {
    name: 'debit/credit direction',
    bullet: /\b[Dd]ebit\b|(?<![Tt]ax )\b[Cc]redit\b(?!\s+[Nn]ote)|\bDr\b|\bCr\b/,
    support: (fact) => /\bdebit\b|\bcredit\b/i.test(fact.text) || fact.kind === 'tieout' || fact.kind === 'books',
    said: /\bdebit\b|\bcredit\b|\bdirection\b|\bDr\b|\bCr\b/i,
  },
  {
    name: 'ledger classification',
    bullet: /\b(?:ledger|account) classification\b|\bwrong (?:ledger|account)\b|\b(?:ledger|account) (?:head|choice|chosen|selection)\b/i,
    support: (fact) => /\bledger\b|\baccount\b/i.test(fact.text) || ['tieout', 'books', 'unmatched'].includes(fact.kind),
    said: /\bledgers?\b|\baccounts?\b|\bclassif\w*\b/i,
  },
  {
    name: 'amount',
    bullet: /\bamounts?\b/i,
    support: (fact) => /\bamount\b|\bRs\b/i.test(fact.text) || ['tieout', 'books', 'unmatched'].includes(fact.kind),
    said: /\bamounts?\b|\bRs\b/i,
  },
];

const VOUCHER_TYPE_WORD = /\b(payment|receipt|sales|purchase|journal|contra|credit note|debit note)\s+(?:voucher\s*)?$/i;

// The ledger a Trial Balance or books fact is about: the words before its
// verb ("Sales shows…", "Purchase Returns has no ledger…").
const LEDGER_FACT_SUBJECT = /^(.+?) (?:shows|closes|does not appear|has no ledger)\b/i;

function ledgerSubjectOf(fact: CoachingFact): string | null {
  if (fact.kind !== 'tieout' && fact.kind !== 'books') return null;
  const match = LEDGER_FACT_SUBJECT.exec(fact.text);
  return match ? match[1].trim() : null;
}

function factSide(fact: CoachingFact): 'debit' | 'credit' | null {
  const match = /\bon the (debit|credit) side\b/i.exec(fact.text);
  return match ? (match[1].toLowerCase() as 'debit' | 'credit') : null;
}

function unmatchedVoucherOf(fact: CoachingFact): { type: string; position: string } | null {
  if (fact.kind !== 'unmatched') return null;
  const match = /^(.+?) voucher no\. (\d+)\b/i.exec(fact.text);
  return match ? { type: match[1].trim().toLowerCase(), position: match[2] } : null;
}

// Sentences of a bullet. "no. 7" and "Rs. 350" are not sentence ends.
function segmentsOf(text: string): { text: string; offset: number }[] {
  const segments: { text: string; offset: number }[] = [];
  const boundary = /(?<!\b(?:no|Rs|vs|viz|nos))[.;:!?](?=\s|$)/gi;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) !== null) {
    segments.push({ text: text.slice(start, match.index), offset: start });
    start = match.index + 1;
  }
  segments.push({ text: text.slice(start), offset: start });
  return segments.filter((segment) => segment.text.trim().length > 0);
}

type OwnerMention = { start: number; end: number; label: string; facts: CoachingFact[] };

// Where each cited fact is named in a sentence: a Trial Balance/books ledger,
// an unmatched voucher's number, or a bill reference. Longer names win over
// names they contain ("Sales Returns" over "Sales"), and a name joined with
// "and" ("Freight and Delivery Charges") is one name, not two.
function ownerMentions(segment: string, citedFacts: CoachingFact[]): OwnerMention[] {
  const candidates: OwnerMention[] = [];
  const phraseOwners = new Map<string, CoachingFact[]>();
  for (const fact of citedFacts) {
    const subject = ledgerSubjectOf(fact);
    const phrases = [...(subject ? [subject] : []), ...identifiersIn(fact.text)];
    for (const phrase of phrases) {
      const key = phrase.toLowerCase();
      phraseOwners.set(key, [...(phraseOwners.get(key) ?? []), fact]);
    }
  }
  for (const [phrase, facts] of phraseOwners) {
    for (const position of phrasePositions(segment, phrase)) {
      candidates.push({ ...position, label: phrase, facts });
    }
  }
  const voucherPattern = /\b(?:voucher\s+)?(?:no\.?|number)\s*(\d+)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = voucherPattern.exec(segment)) !== null) {
    const position = match[1];
    const facts = citedFacts.filter((fact) => unmatchedVoucherOf(fact)?.position === position);
    candidates.push({ start: match.index, end: match.index + match[0].length, label: `voucher no. ${position}`, facts });
  }
  candidates.sort((a, b) => b.end - b.start - (a.end - a.start));
  const kept: OwnerMention[] = [];
  for (const candidate of candidates) {
    if (!kept.some((other) => candidate.start < other.end && other.start < candidate.end)) {
      kept.push(candidate);
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}

function ownerAt(mentions: OwnerMention[], start: number, end: number): OwnerMention | null {
  const before = mentions.filter((mention) => mention.end <= start);
  if (before.length > 0) return before[before.length - 1];
  return mentions.find((mention) => mention.start >= end) ?? null;
}

// Figures (and voucher types, and debit/credit sides) put against the wrong
// fact inside a merged bullet. The pooled check only asks whether a figure
// appears in ANY cited fact, so "Sales is off by Rs 8,000 and Purchases by
// Rs 15,000" passed when the facts said the reverse (review finding,
// 2026-09-16). Attribution is positional within a sentence (2026-09-17):
// each figure belongs to the nearest fact named before it, which also
// catches comma-joined swaps ("Purchases is off by Rs 15,000, as is Sales by
// Rs 8,000"), unmatched vouchers traded between numbers, a Trial Balance
// figure laundered onto an invoice reference, and a flipped side.
function misattributions(bulletText: string, citedFacts: CoachingFact[]): string[] {
  const problems: string[] = [];
  const hasOwners = citedFacts.some(
    (fact) => ledgerSubjectOf(fact) !== null || unmatchedVoucherOf(fact) !== null || identifiersIn(fact.text).length > 0,
  );
  if (!hasOwners) return problems;
  const ledgerSides = [...new Set(citedFacts.map(factSide).filter((side): side is 'debit' | 'credit' => side !== null))];

  for (const segment of segmentsOf(bulletText)) {
    const mentions = ownerMentions(segment.text, citedFacts);

    for (const mention of mentions) {
      if (mention.facts.length === 0 && mention.label.startsWith('voucher no.')) continue;
      const voucher = mention.facts.map(unmatchedVoucherOf).find((value) => value !== null);
      if (voucher) {
        const typed = VOUCHER_TYPE_WORD.exec(segment.text.slice(Math.max(0, mention.start - 30), mention.start));
        if (typed && typed[1].toLowerCase() !== voucher.type) {
          problems.push(`${typed[1]} voucher no. ${voucher.position}, which the facts list as a ${voucher.type} voucher`);
        }
      }
    }

    if (citedFacts.length >= 2 && mentions.length > 0) {
      let masked = segment.text;
      for (const mention of mentions) {
        masked = `${masked.slice(0, mention.start)}${' '.repeat(mention.end - mention.start)}${masked.slice(mention.end)}`;
      }
      for (const reference of identifiersIn(masked)) {
        masked = masked.split(reference).join(' '.repeat(reference.length));
      }
      const figurePattern = /\d[\d,]*(?:\.\d+)?/g;
      let figure: RegExpExecArray | null;
      while ((figure = figurePattern.exec(masked)) !== null) {
        const value = numbersIn(figure[0])[0];
        if (value === undefined) continue;
        const owner = ownerAt(mentions, figure.index, figure.index + figure[0].length);
        if (!owner || owner.facts.length === 0) continue;
        const ownFigures = new Set(owner.facts.flatMap((fact) => numbersIn(fact.text)));
        if (!ownFigures.has(value)) {
          problems.push(`${value} next to ${owner.label}`);
        }
      }
    }

    const sidePattern = /\b(debit|credit)\b|\b(Dr|Cr)\b/g;
    let side: RegExpExecArray | null;
    while ((side = sidePattern.exec(segment.text)) !== null) {
      if (/tax\s+$/i.test(segment.text.slice(0, side.index)) || /^\s+note\b/i.test(segment.text.slice(side.index + side[0].length))) continue;
      const stated = side[1] ? side[1].toLowerCase() : side[2] === 'Dr' ? 'debit' : 'credit';
      const owner = ownerAt(
        mentions.filter((mention) => mention.facts.some((fact) => factSide(fact) !== null)),
        side.index,
        side.index + side[0].length,
      );
      const expected = owner
        ? (owner.facts.map(factSide).find((value) => value !== null) ?? null)
        : ledgerSides.length === 1
          ? ledgerSides[0]
          : null;
      if (expected && stated !== expected) {
        problems.push(`"${side[0]}" where the facts say the ${expected} side`);
      }
    }
  }
  return [...new Set(problems)];
}

// What must appear in a bullet for a cited issue fact to count as STATED
// (2026-09-17): one of its identifiers, names or figures, or a word of its
// concept. A catch-all "check the remaining findings" citing six facts used
// to satisfy the every-finding-cited rule while saying none of them.
function isFactStated(bulletText: string, fact: CoachingFact, knownNames: readonly string[]): boolean {
  const phrases = [
    ...identifiersIn(fact.text),
    ...(ledgerSubjectOf(fact) ? [ledgerSubjectOf(fact) as string] : []),
    ...knownNames.filter((name) => containsPhrase(fact.text, name)),
  ];
  if (phrases.some((phrase) => containsPhrase(bulletText, phrase))) return true;
  const voucher = unmatchedVoucherOf(fact);
  if (voucher && new RegExp(String.raw`\b(?:no\.?|number)\s*${voucher.position}\b`, 'i').test(bulletText)) return true;
  const bulletFigures = new Set(numbersIn(bulletText));
  if (numbersIn(fact.text).some((figure) => bulletFigures.has(figure))) return true;
  if (CONCEPT_FAMILIES.some((family) => family.said.test(fact.text) && family.said.test(bulletText))) return true;
  if (/not to have been recorded/.test(fact.text) && /\b(?:recorded|posted|entered|missing|missed)\b/i.test(bulletText)) return true;
  if (/written answer/.test(fact.text) && /\b(?:written|answer|explanation|explained|reasoning)\b/i.test(bulletText)) return true;
  if (fact.kind === 'missing' && /\b(?:arrived|missing|never|explanation|answer|part)\b/i.test(bulletText)) return true;
  if (fact.kind === 'ledger' && /\bledgers?\b/i.test(bulletText)) return true;
  return false;
}

// Known names a bullet uses. Single-word names ("Sales", "Rent") only count
// when written capitalised as a ledger name, so "the sales invoice" stays
// ordinary prose.
function namesUsedIn(text: string, knownNames: readonly string[]): string[] {
  const used: { name: string; start: number; end: number }[] = [];
  for (const name of [...knownNames].sort((a, b) => b.length - a.length)) {
    const singleWord = !/\s/.test(name);
    for (const position of phrasePositions(text, name)) {
      if (singleWord && text.slice(position.start, position.end) !== name) continue;
      if (used.some((other) => position.start < other.end && other.start < position.end)) continue;
      used.push({ name, ...position });
    }
  }
  return [...new Set(used.map((entry) => entry.name))];
}

export type GroundingContext = { tbTieOut: boolean | null; knownNames?: readonly string[] };

// The citation contract, checked in code (2026-09-16). Returns every
// violation found, each phrased so it can be handed straight back to the
// model; an empty list means the output is grounded. Pure and exported for
// tests. The rules:
//  - every bullet cites at least one listed fact; went_well cites only
//    praise/fixed facts, needs_work only issue-type facts;
//  - every identifier, number and known ledger/party name in a bullet occurs
//    in the text of the facts that bullet cites, and each figure, voucher
//    type and debit/credit side sits against the fact it belongs to;
//  - concept words (GST, TDS, bill references, narration, voucher type,
//    ledger classification, amount, debit/credit) need a cited fact about
//    that concept;
//  - no spelled-out figures, dates in words, "respectively" across figures;
//  - history words only in a bullet citing a fixed/still fact (or a fact
//    whose own text uses history words); in opening_line only when a
//    fixed/still fact exists;
//  - needs_work carries no praise wording; went_well and opening_line carry
//    no totality claims ("every entry", "perfect", "clean") while any finding
//    exists;
//  - every issue-type fact is cited at least once AND stated in the bullet
//    citing it, so no finding is dropped;
//  - opening_line keeps the score/verdict/Trial Balance rules and carries no
//    numbers or identifiers;
//  - no em dash or en dash anywhere.
export function checkGrounding(
  output: CoachingModelOutput,
  facts: CoachingFact[],
  context: GroundingContext,
): string[] {
  const violations: string[] = [];
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const cited = new Set<string>();
  const hasHistoryFacts = facts.some((fact) => HISTORY_KINDS.has(fact.kind));
  const hasIssueFacts = facts.some((fact) => ISSUE_KINDS.has(fact.kind));
  const knownNames = context.knownNames ?? [];

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
        if (section.name === 'needs_work' && ISSUE_KINDS.has(fact.kind)) {
          cited.add(id);
        }
        citedFacts.push(fact);
      }

      const sourceText = citedFacts.map((fact) => fact.text).join(' \n ');
      // A lexical rule never rejects wording the cited fact itself uses.
      const inFacts = (phrase: string) => sourceText.toLowerCase().includes(phrase.toLowerCase());

      const allowedIdentifiers = new Set(identifiersIn(sourceText).map((id) => id.toLowerCase()));
      const unknownIdentifiers = [...new Set(identifiersIn(bullet.text).filter((id) => !allowedIdentifiers.has(id.toLowerCase())))];
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

      const unknownNames = namesUsedIn(bullet.text, knownNames).filter((name) => !containsPhrase(sourceText, name));
      if (unknownNames.length > 0) {
        violations.push(
          `${where} names ${unknownNames.join(', ')}, which the facts it cites do not name. Name only the ledgers and parties written in a cited fact.`,
        );
      }

      const misattributed = misattributions(bullet.text, citedFacts);
      if (misattributed.length > 0) {
        violations.push(
          `${where} puts a detail against the wrong fact (${misattributed.join('; ')}). Each ledger's or voucher's figure, type and side must come from that ledger's or voucher's own fact.`,
        );
      }

      if (RESPECTIVELY_PATTERN.test(bullet.text) && citedFacts.filter((fact) => numbersIn(fact.text).length > 0).length >= 2) {
        violations.push(`${where} uses "respectively" across several facts' figures. Put each figure directly after the ledger or voucher it belongs to.`);
      }

      const spelled = SPELLED_NUMBER_PATTERN.exec(bullet.text);
      if (spelled && !inFacts(spelled[0])) {
        violations.push(`${where} writes a figure in words ("${spelled[0]}"). Copy figures in digits from a cited fact.`);
      }
      const wordedDate = WORDED_DATE_PATTERN.exec(bullet.text);
      if (wordedDate) {
        violations.push(`${where} writes a date in words ("${wordedDate[0]}"). Copy dates exactly from a cited fact.`);
      }

      for (const family of CONCEPT_FAMILIES) {
        const match = family.bullet.exec(bullet.text);
        if (match && citedFacts.length > 0 && !citedFacts.some(family.support)) {
          violations.push(
            `${where} talks about ${family.name} ("${match[0]}"), but none of the facts it cites is about ${family.name}. Keep each bullet to the concept its facts name.`,
          );
        }
      }

      const historyMatch = HISTORY_PATTERN.exec(bullet.text);
      const historyAllowed = citedFacts.some((fact) => HISTORY_KINDS.has(fact.kind) || HISTORY_PATTERN.test(fact.text));
      if (historyMatch && !historyAllowed) {
        violations.push(
          `${where} uses "${historyMatch[0]}", which claims history no cited fact supports. Remove any reference to earlier attempts.`,
        );
      }

      if (section.name === 'needs_work') {
        const praise = NEEDS_WORK_PRAISE_PATTERN.exec(bullet.text);
        if (praise && !inFacts(praise[0])) {
          violations.push(`${where} says "${praise[0]}" about a finding. A needs_work bullet never calls the finding fine or correct.`);
        }
        for (const fact of citedFacts) {
          if (ISSUE_KINDS.has(fact.kind) && !isFactStated(bullet.text, fact, knownNames)) {
            violations.push(
              `${where} cites ${fact.id} without saying anything from it. Name that fact's ledger, voucher, reference, figure or concept in the bullet, or give it its own bullet.`,
            );
          }
        }
      } else {
        const overclaim = OVERCLAIM_PATTERN.exec(bullet.text);
        const firstWord = overclaim?.[0].split(/\s+/)[0] ?? '';
        const wholeField = citedFacts.every((fact) => !/\(|\bon\b.+\bwas handled correctly$/.test(fact.text));
        if (overclaim && !inFacts(firstWord) && (hasIssueFacts || !wholeField)) {
          violations.push(
            `${where} claims "${overclaim[0]}", but ${hasIssueFacts ? 'there are findings in needs_work' : 'the praise it cites covers only some entries'}. Praise exactly what the cited facts praise.`,
          );
        }
      }

      const dash = dashViolation(bullet.text);
      if (dash) {
        violations.push(`${where} contains ${dash}. Use a colon, a comma or a full stop.`);
      }
    });
  }

  const uncited = facts.filter((fact) => ISSUE_KINDS.has(fact.kind) && !cited.has(fact.id));
  if (uncited.length > 0) {
    violations.push(
      `These findings are not cited by any needs_work bullet: ${uncited.map((fact) => fact.id).join(', ')}. Every I, U, L, T, B, S and M fact must be covered.`,
    );
  }

  const openingIssue = checkOpeningLineFacts(output.opening_line, { tbTieOut: context.tbTieOut, hasIssueFacts });
  if (openingIssue !== null) {
    violations.push(openingIssue);
  }
  if (numbersIn(output.opening_line).length > 0 || identifiersIn(output.opening_line).length > 0) {
    violations.push('Your opening_line contains a number or an identifier. It cites no fact, so it must contain neither.');
  }
  const openingNames = namesUsedIn(output.opening_line, knownNames).filter((name) => name.includes(' '));
  if (openingNames.length > 0) {
    violations.push(`Your opening_line names ${openingNames.join(', ')}. It cites no fact, so name no ledger or party in it.`);
  }
  const openingHistory = HISTORY_PATTERN.exec(output.opening_line);
  if (openingHistory && !hasHistoryFacts) {
    violations.push(
      `Your opening_line uses "${openingHistory[0]}", but there are no F or S facts. Say nothing about earlier attempts.`,
    );
  }
  const openingDash = dashViolation(output.opening_line);
  if (openingDash) {
    violations.push(`Your opening_line contains ${openingDash}. Use a colon, a comma or a full stop.`);
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
// feedback into a pointless retry, so only its verdict shapes are caught:
// "passes", "did not pass", "a pass" and a bare "passed" with no entry after
// it ("the batch passed", 2026-09-17).
const VERDICT_LANGUAGE_PATTERN =
  /\bpartial(?:ly)?\b|\bfail(?:s|ed|ure|ing)?\b|\bpasses\b|\b(?:did|does|do)\s+not\s+pass\b|\bnot a pass\b|\ba (?:clear |clean |solid )?pass\b|\bpassed\b(?!\s+(?:the|your|all|every|each|a|an|these|those|its|this|that|both|most|entries|entry|journals?|vouchers?|postings?))/i;

// A Trial Balance described as matching when the tie-out did not (2026-09-17
// audit: "Your Trial Balance matched and every entry is right").
const TRIAL_BALANCE_MATCH_PATTERN =
  /trial\s*balance\b[^.]*?\b(?:matched|matches|tied|ties|tallied|tallies|agreed|agrees|balanced|balances|squared|squares)\b|\b(?:matched|tied|tallied|agreed|balanced)\b[^.]*?\btrial\s*balance\b/i;

// Returns a retry-feedback message when opening_line contradicts the computed
// scoring facts or reaches for score/verdict language, null when it's clean.
// Exported for tests. hasIssueFacts is optional so a caller with no fact list
// still gets the score, verdict and Trial Balance rules.
export function checkOpeningLineFacts(
  openingLine: string,
  signal: Pick<CoachingSignal, 'tbTieOut'> & { hasIssueFacts?: boolean },
): string | null {
  if (signal.tbTieOut === true && /trial\s*balance/i.test(openingLine)) {
    return 'Your opening_line attributes the result to the Trial Balance, but the Trial Balance tie-out MATCHED. Restate the opening_line without mentioning the Trial Balance.';
  }
  if (signal.tbTieOut === false && TRIAL_BALANCE_MATCH_PATTERN.test(openingLine)) {
    return 'Your opening_line says the Trial Balance matched, but the Trial Balance tie-out did NOT match. Restate the opening_line without claiming it did.';
  }
  if (SCORE_LANGUAGE_PATTERN.test(openingLine)) {
    return 'Your opening_line states a score, a percentage or a mark. Learners are never shown one. Restate it saying what the batch showed, with no numbers about performance.';
  }
  if (VERDICT_LANGUAGE_PATTERN.test(openingLine)) {
    return 'Your opening_line uses a verdict word ("partial", "fail", "passes", "a pass"). Learners are never given a verdict. Restate it saying what went right and what the sections below cover.';
  }
  const overclaim = signal.hasIssueFacts ? OVERCLAIM_PATTERN.exec(openingLine) : null;
  if (overclaim) {
    return `Your opening_line claims "${overclaim[0]}", but there are findings in needs_work. Restate it without calling the batch complete, clean or perfect.`;
  }
  return null;
}

// Deterministic opening line used only when the model repeatedly produces a
// factually-wrong one: plain and safe rather than clever, no score, no
// verdict, no em dashes (learner-facing hard rule). These lines must
// themselves survive checkOpeningLineFacts, since they are what replaces a
// line that failed it.
//
// Derived from the facts when they are given (2026-09-17): "This batch came
// out clean" was chosen from overallResult alone and could sit above a
// needs_work list, since a 'pass' can still carry findings.
export function composeFallbackOpeningLine(
  signal: Pick<CoachingSignal, 'overallResult'> & { hasIssueFacts?: boolean; hasPraiseFacts?: boolean },
): string {
  const hasIssues = signal.hasIssueFacts ?? signal.overallResult !== 'pass';
  if (!hasIssues) {
    return 'Nothing in this batch needs another look. Here is what you got right.';
  }
  if (signal.hasPraiseFacts ?? signal.overallResult === 'partial') {
    return 'Some of this batch is in place, and the areas below are worth another look.';
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
    opening_line: composeFallbackOpeningLine({
      overallResult: signal.overallResult,
      hasIssueFacts: facts.some((fact) => ISSUE_KINDS.has(fact.kind)),
      hasPraiseFacts: facts.some((fact) => PRAISE_KINDS.has(fact.kind)),
    }),
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
