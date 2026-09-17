import type { ParsedDayBook, ParsedTrialBalance, Voucher, LedgerEntry } from '@/lib/schemas/voucher';
import { isRetiredConcept, type AnswerKey, type AnswerKeyEntry, type ConceptTag } from '@/lib/schemas/exercise';
import type {
  ScoringErrorCode,
  ScoringResult,
  ScoredField,
  VoucherDiff,
  ConceptResult,
  TieOutMismatch,
  UnmatchedVoucher,
  LedgerFinding,
  CompositeMatch,
} from '@/lib/schemas/scoring';
import { isBankLedger, parseBillReferences } from '@/lib/db/queries/company';
import { findLedgerFindings } from './ledger-findings';
import {
  accountNamesMatch,
  aliasAcceptsLedger,
  aliasFitsAccount,
  classifyLedger,
  gstHeadOf,
  headWisePayableHead,
  isGenericGstPayable,
  isTaxLedgerName,
  keyAccountSet,
  namesCompatible,
  normalizeAccountName,
  partyAccountsOf,
  tdsSectionOf,
  type AccountMatchOptions,
} from './account-names';
import { combinedGstRate } from './generation-checks';
import { optimiseSetOff, type GstHead } from './month-end-journals';
import { roundTdsAmount, tdsSectionFromText } from './tax-rules';

export { accountNamesMatch, normalizeAccountName };

// Weighted-score thresholds for overall_result. Defined here, not scattered as
// magic numbers in the diff/weighting logic below.
const PASS_THRESHOLD = 0.9;
const PARTIAL_THRESHOLD = 0.6;

// GST and TDS mismatches count double toward the weighted score, since
// classification correctness there is the highest-stakes accounting judgment
// this product teaches (see project-overview.md's scoring description).
const GST_TDS_WEIGHT = 2;
const STANDARD_WEIGHT = 1;

const FIELD_WEIGHT: Record<ScoredField, number> = {
  account: STANDARD_WEIGHT,
  dr_cr: STANDARD_WEIGHT,
  amount: STANDARD_WEIGHT,
  voucher_type: STANDARD_WEIGHT,
  gst: GST_TDS_WEIGHT,
  tds: GST_TDS_WEIGHT,
  bill_reference: STANDARD_WEIGHT,
  narration: STANDARD_WEIGHT,
};

// Recognizable Tally ledger-name substrings for inferring GST head from the
// parsed submission, since the Unit 05 voucher parser only extracts raw
// ledger name + amount, not a structured tax classification.
// ASSUMPTION: matches on ledger name text, per Unit 06 spec discussion — the
// parsed voucher shape carries no structured GST/TDS fields, so classification
// is inferred here rather than extending Unit 05's parser.
// Aliases that do not fit the account (a base ledger listed for a returns
// ledger) are ignored here exactly as in the tie-out (2026-09-16): a credit
// note debited to "Credit Sales A/c" on a Sales Returns leg is ACCOUNT_WRONG.
// The voucher is still paired with its transaction through the party leg,
// amounts and type, so only the account field is flagged.
// Name matching plus the batch's advance references (2026-09-17), threaded
// through every diff so the scorer and the adjudicator judge alike.
// `gstBooks` (2026-09-17, second round): the learner's own GST ledger
// movements for the month, which the month-end set-off is judged against.
export type ScoringOptions = AccountMatchOptions & { advanceReferences?: ReadonlySet<string>; gstBooks?: LearnerGstBooks };

// Aliases go through aliasAcceptsLedger (2026-09-17): the ledger must not
// contradict the account itself (a payable for an expense head, "Interest
// Paid" for Interest Income), and the key's own accounts are passed so typo
// tolerance never equates two distinct accounts of the batch.
function legMatchesEntry(entry: LedgerEntry, leg: AnswerKeyEntry, options: ScoringOptions = {}): boolean {
  if (accountNamesMatch(entry.ledgerName, leg.correct_account, options)) {
    return true;
  }
  if (headWisePayableFitsLeg(entry, leg, options)) {
    return true;
  }
  return (leg.account_aliases ?? []).some((alias) => aliasAcceptsLedger(entry.ledgerName, alias, leg.correct_account, options));
}

// Head-wise payables stand for the key's single "GST Payable" (2026-09-17,
// second round). The pilot learner credited "IGST Payable" where the pack
// says GST Payable (seq 99), and the stricter name rules flagged a
// legitimate practice. A payable per head, or several of them together
// (merged in pairLegsToEntries), fills the GST Payable leg; the set-off
// check (judgeGstSetOff) then confirms each head's payable holds only that
// head's liability. A ledger the key names as an account of its own is not
// borrowed.
const HEAD_WISE_PAYABLE_MERGES = new WeakSet<LedgerEntry>();

function headWisePayableFitsLeg(entry: LedgerEntry, leg: AnswerKeyEntry, options: ScoringOptions): boolean {
  if (!isGenericGstPayable(leg.correct_account)) return false;
  if (options.keyAccounts?.has(normalizeAccountName(entry.ledgerName))) return false;
  return HEAD_WISE_PAYABLE_MERGES.has(entry) || headWisePayableHead(entry.ledgerName) !== null;
}

function mergeHeadWisePayables(entries: LedgerEntry[], legs: AnswerKeyEntry[], options: ScoringOptions): LedgerEntry[] {
  if (legs.some((leg) => headWisePayableHead(leg.correct_account) !== null)) return entries;
  let merged = entries;
  for (const side of ['Dr', 'Cr'] as const) {
    const payableLeg = legs.find((leg) => leg.dr_cr === side && isGenericGstPayable(leg.correct_account));
    if (!payableLeg) continue;
    const parts = merged.filter(
      (entry) => entry.drOrCr === side && headWisePayableFitsLeg(entry, payableLeg, options) && !HEAD_WISE_PAYABLE_MERGES.has(entry),
    );
    if (parts.length < 2) continue;
    const combined: LedgerEntry = {
      ledgerName: parts.map((part) => part.ledgerName).join(' + '),
      amount: round2(parts.reduce((sum, part) => sum + part.amount, 0)),
      drOrCr: side,
      billAllocations: parts.flatMap((part) => part.billAllocations),
    };
    HEAD_WISE_PAYABLE_MERGES.add(combined);
    const first = merged.indexOf(parts[0]);
    merged = merged.filter((entry) => !parts.includes(entry));
    merged.splice(first, 0, combined);
  }
  return merged;
}

// Voucher types by their base (2026-09-17). Tally lets a company create its
// own types ("GST Sales", "Sales - Local") under a base type, and the Day
// Book export names only the custom type: VOUCHERTYPENAME and VCHTYPE carry
// the custom name, OBJVIEW / PERSISTEDVIEW only the entry view ("Invoice
// Voucher View"), never the parent. Exact comparison marked every such
// voucher VOUCHER_TYPE_WRONG and skipped the GST side check. A custom name
// maps to its base when it names exactly one base type; a "... Return(s)"
// type is the note Tally uses for it. Anything else stays as written.
const BASE_TYPE_WORDS: Record<string, string> = {
  sales: 'sales', sale: 'sales',
  purchase: 'purchase', purchases: 'purchase',
  payment: 'payment', payments: 'payment',
  receipt: 'receipt', receipts: 'receipt',
  contra: 'contra',
  journal: 'journal', journals: 'journal',
};

export function baseVoucherType(voucherType: string): string {
  const name = voucherType.trim().toLowerCase().replace(/\s+/g, ' ');
  const words = name.split(/[^a-z]+/).filter((word) => word.length > 0);
  const bases = new Set<string>();
  const joined = ` ${words.join(' ')} `;
  if (joined.includes(' credit note ')) bases.add('credit note');
  if (joined.includes(' debit note ')) bases.add('debit note');
  for (const word of words) {
    if (BASE_TYPE_WORDS[word]) bases.add(BASE_TYPE_WORDS[word]);
  }
  if (words.some((word) => word === 'return' || word === 'returns')) {
    if (bases.size === 1 && bases.has('sales')) return 'credit note';
    if (bases.size === 1 && bases.has('purchase')) return 'debit note';
  }
  return bases.size === 1 ? [...bases][0] : name;
}

function sameVoucherType(a: string, b: string): boolean {
  return baseVoucherType(a) === baseVoucherType(b);
}

const GST_HEAD_PATTERNS: { pattern: RegExp; head: 'IGST' | 'CGST' | 'SGST' }[] = [
  { pattern: /\bIGST\b/i, head: 'IGST' },
  { pattern: /\bCGST\b/i, head: 'CGST' },
  { pattern: /\bSGST\b/i, head: 'SGST' },
];

const TDS_LEDGER_PATTERN = /\bTDS\b/i;

// Collects EVERY GST head posted on the voucher, not just the first: an
// intra-state posting is a CGST+SGST pair, and first-match inference cannot
// tell a correct pair from CGST posted twice with SGST missing (a real pilot
// submission, HR-118, sailed through exactly that way — 2026-08-31).
function collectGstFromLedgerEntries(entries: LedgerEntry[]): {
  heads: Set<'IGST' | 'CGST' | 'SGST'>;
  sides: Set<'input' | 'output'>;
} {
  const heads = new Set<'IGST' | 'CGST' | 'SGST'>();
  const sides = new Set<'input' | 'output'>();
  for (const entry of entries) {
    for (const candidate of GST_HEAD_PATTERNS) {
      if (candidate.pattern.test(entry.ledgerName)) {
        heads.add(candidate.head);
        if (/\binput\b/i.test(entry.ledgerName)) {
          sides.add('input');
        } else if (/\boutput\b/i.test(entry.ledgerName)) {
          sides.add('output');
        }
      }
    }
  }
  return { heads, sides };
}

// Which GST side a voucher type should touch: sales-side vouchers (Sales,
// Credit Note) carry OUTPUT GST; purchase-side (Purchase, Debit Note) and
// expense payments carry INPUT GST. Reversing a sales return through Input
// GST was one of the pilot reviewer's explicit findings — head-only checking
// cannot catch it, since the head (CGST) is right and only the side is wrong.
function expectedGstSide(voucherType: string): 'input' | 'output' | null {
  const type = baseVoucherType(voucherType);
  // A receipt carries GST only for a service advance (rulebook 9B: Output
  // GST on Advance), so any GST on a receipt is output-side.
  if (type === 'sales' || type === 'credit note' || type === 'receipt') {
    return 'output';
  }
  if (type === 'purchase' || type === 'debit note' || type === 'payment') {
    return 'input';
  }
  return null;
}

function inferTdsFromLedgerEntries(entries: LedgerEntry[]): { amount: number } | null {
  const tdsEntry = entries.find((entry) => TDS_LEDGER_PATTERN.test(entry.ledgerName));
  return tdsEntry ? { amount: tdsEntry.amount } : null;
}

// A transaction's answer key is real double-entry: one Dr leg + one Cr leg
// (possibly more for split/multi-line postings) sharing the same `sequence`.
// Each leg is diffed against whichever unmatched ledger entry on the voucher
// best matches it (by account name), so a learner who gets one leg right and
// the other wrong is scored correctly on both legs, not just the first match.
// voucher_type/gst/tds/bill_reference/narration are voucher-level, not
// leg-level, so they're diffed once per voucher (against the first leg),
// not once per leg — matching per-leg would double-count identical values.
// A multi-rate invoice (furniture at 9%+9%, packing at 6%+6%) lands in a
// generated key as two CGST legs and two SGST legs, but Tally shows ONE
// combined CGST line and ONE SGST line on the voucher — and some learners
// type two lines anyway. Both are the same correct posting, so legs and
// ledger entries are consolidated by (account, side) before leg matching;
// otherwise the second CGST leg found nothing left to match and the natural
// posting scored two false ACCOUNT_WRONGs (Garima's Level 3 Tx 7, 76% vs
// 100%, 2026-09-02). GST pair completeness still reads the raw entries.
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function consolidateExpectedLegs(legs: AnswerKeyEntry[]): AnswerKeyEntry[] {
  const merged: AnswerKeyEntry[] = [];
  for (const leg of legs) {
    const existing = merged.find(
      (m) => m.dr_cr === leg.dr_cr && normalizeAccountName(m.correct_account) === normalizeAccountName(leg.correct_account),
    );
    if (existing) {
      existing.amount = round2(existing.amount + leg.amount);
    } else {
      merged.push({ ...leg });
    }
  }
  return merged;
}

function consolidateLedgerEntries(entries: LedgerEntry[]): LedgerEntry[] {
  const merged: LedgerEntry[] = [];
  for (const entry of entries) {
    const existing = merged.find(
      (m) => m.drOrCr === entry.drOrCr && normalizeAccountName(m.ledgerName) === normalizeAccountName(entry.ledgerName),
    );
    if (existing) {
      existing.amount = round2(existing.amount + entry.amount);
      existing.billAllocations = [...existing.billAllocations, ...entry.billAllocations];
    } else {
      merged.push({ ...entry, billAllocations: [...entry.billAllocations] });
    }
  }
  return merged;
}

// Pairs each (consolidated) expected leg with a (consolidated) posted entry.
// Exported for the adjudicator, which needs the same pairing to know which
// posted ledger a dismissed account finding is about.
export type LegPairing = { entries: LedgerEntry[]; legs: AnswerKeyEntry[]; assigned: Map<number, LedgerEntry>; leftover: LedgerEntry[] };

export function pairLegsToEntries(voucher: Voucher, expectedLegs: AnswerKeyEntry[], options: ScoringOptions = {}): LegPairing {
  const consolidated = consolidateExpectedLegs(expectedLegs);
  const entries = mergeHeadWisePayables(consolidateLedgerEntries(voucher.ledgerEntries), consolidated, options);
  const unmatchedEntries = [...entries];

  // Pair expected legs to posted entries in two passes. Pass 1 claims an
  // entry by the account NAME; only pass 2 falls back to the key's aliases.
  // In a single pass the alias "Advertising" (for Advertisement &
  // Marketing) claimed the party entry "Signage Advertising" before the
  // party leg had its turn, and a correctly posted party scored
  // DR_CR_REVERSED + AMOUNT_WRONG (Yeshas's Level 4 SA-105, 2026-09-04).
  // Pass 0: an entry whose name IS the key's account (after normalisation)
  // belongs to that leg and nothing else. Without it the lenient name match
  // let key leg "Output CGST 6%" claim the posted "Output CGST 9%" entry
  // first, leaving the real 6% entry to be mis-paired down the line
  // (Praveen's February GST set-off, nine legs, 2026-09-07).
  const assigned = new Map<number, LedgerEntry>();
  consolidated.forEach((leg, index) => {
    const expectedName = normalizeAccountName(leg.correct_account);
    const matchIndex = unmatchedEntries.findIndex((entry) => normalizeAccountName(entry.ledgerName) === expectedName);
    if (matchIndex !== -1) {
      assigned.set(index, unmatchedEntries.splice(matchIndex, 1)[0]);
    }
  });
  consolidated.forEach((leg, index) => {
    if (assigned.has(index)) return;
    const matchIndex = unmatchedEntries.findIndex((entry) => accountNamesMatch(entry.ledgerName, leg.correct_account, options));
    if (matchIndex !== -1) {
      assigned.set(index, unmatchedEntries.splice(matchIndex, 1)[0]);
    }
  });
  consolidated.forEach((leg, index) => {
    if (assigned.has(index)) return;
    const matchIndex = unmatchedEntries.findIndex((entry) => legMatchesEntry(entry, leg, options));
    if (matchIndex !== -1) {
      assigned.set(index, unmatchedEntries.splice(matchIndex, 1)[0]);
    }
  });
  return { entries, legs: consolidated, assigned, leftover: unmatchedEntries };
}

// The weight a transaction is worth when every field is scored: account,
// side and amount per consolidated leg, plus voucher type, GST, TDS, bill
// reference and (when the key names a statement reference) narration.
function transactionWeight(expectedLegs: AnswerKeyEntry[]): number {
  const legs = consolidateExpectedLegs(expectedLegs).length;
  const perLeg = FIELD_WEIGHT.account + FIELD_WEIGHT.dr_cr + FIELD_WEIGHT.amount;
  const voucherLevel = FIELD_WEIGHT.voucher_type + FIELD_WEIGHT.gst + FIELD_WEIGHT.tds + FIELD_WEIGHT.bill_reference;
  const narration = expectedLegs.some((leg) => KEY_BANK_REFERENCE.test(leg.narration ?? '')) ? FIELD_WEIGHT.narration : 0;
  return legs * perLeg + voucherLevel + narration;
}

function diffVoucherAgainstAnswerKey(
  voucher: Voucher | undefined,
  expectedLegs: AnswerKeyEntry[],
  options: ScoringOptions = {},
): VoucherDiff[] {
  const diffs: VoucherDiff[] = [];
  const sequence = expectedLegs[0].sequence;

  if (!voucher) {
    // A missing voucher costs the full weight of what the transaction would
    // have been scored on (2026-09-17). At one standard weight, skipping a
    // hard voucher scored better than attempting it and getting a leg wrong.
    diffs.push({
      voucherRef: sequence,
      field: 'account',
      expected_masked: true,
      is_correct: false,
      error_code: 'VOUCHER_MISSING',
      weight: transactionWeight(expectedLegs),
    });
    return diffs;
  }

  const { legs: consolidated, assigned } = pairLegsToEntries(voucher, expectedLegs, options);
  const setOffTransaction = isGstSetOffTransaction(expectedLegs);

  for (const [index, expectedLeg] of consolidated.entries()) {
    const matchingEntry = assigned.get(index);

    diffs.push({
      voucherRef: sequence,
      field: 'account',
      expected_masked: true,
      is_correct: matchingEntry !== undefined,
      error_code: matchingEntry === undefined ? 'ACCOUNT_WRONG' : null,
      leg: index,
    });

    if (matchingEntry === undefined) {
      // No posted entry belongs to this leg, so there is no side or amount
      // to judge (2026-09-17). Scoring them as wrong as well charged one
      // slip three times; they are recorded as not scored (weight 0) and the
      // account error is the whole penalty. Voucher-basics concepts still
      // fail on the account diff.
      for (const field of ['dr_cr', 'amount'] as const) {
        diffs.push({
          voucherRef: sequence,
          field,
          expected_masked: true,
          is_correct: true,
          vacuously_correct: true,
          error_code: null,
          leg: index,
          weight: 0,
        });
      }
      continue;
    }

    const drCrCorrect = matchingEntry.drOrCr === expectedLeg.dr_cr;
    diffs.push({
      voucherRef: sequence,
      field: 'dr_cr',
      expected_masked: true,
      is_correct: drCrCorrect,
      error_code: drCrCorrect ? null : 'DR_CR_REVERSED',
      leg: index,
    });

    // Tax legs are amount-checked (2026-09-17, second round). Every GST and
    // TDS leg used to be skipped so a set-off's upstream slips would not
    // cascade, which let a wrong TDS deduction or a wrong GST figure on an
    // ordinary voucher pass. Now a tax leg must equal the key within a rupee
    // of rounding (s. 288B / TRACES round TDS to the rupee; invoices round
    // each GST head). Only the month-end set-off's tax legs are left
    // unscored here: their figures come from the learner's own ledgers and
    // are judged by judgeGstSetOff through the gst field.
    // Tax ledgers by word (2026-09-17): "Kingston Traders" holds "gst".
    const taxLeg = isTaxLedgerName(expectedLeg.correct_account);
    const setOffTaxLeg = taxLeg && setOffTransaction;
    const amountCorrect =
      setOffTaxLeg ||
      (taxLeg ? Math.abs(matchingEntry.amount - expectedLeg.amount) <= TAX_AMOUNT_TOLERANCE : amountsMatch(matchingEntry.amount, expectedLeg.amount));
    diffs.push({
      voucherRef: sequence,
      field: 'amount',
      expected_masked: true,
      is_correct: amountCorrect,
      vacuously_correct: setOffTaxLeg ? true : undefined,
      error_code: amountCorrect ? null : 'AMOUNT_WRONG',
      leg: index,
    });
  }

  // Voucher-level fields: voucher_type/bill_reference/narration are shared by
  // every leg, so the first leg represents the transaction — EXCEPT the tax
  // expectation. Generated keys carry gst_head/tds_section only on the tax
  // leg itself (the party leg says null), so reading legs[0] declared "no
  // GST expected" and flagged every correct GST posting as GST_UNEXPECTED
  // (Garima's Level 2: 6 of 6 taxed transactions, 2026-09-02). The
  // transaction's expectation is whichever leg states one.
  const expected = voucherLevelExpectation(expectedLegs);

  const voucherTypeCorrect = sameVoucherType(voucher.voucherType, expected.voucher_type);
  diffs.push({
    voucherRef: sequence,
    field: 'voucher_type',
    expected_masked: true,
    is_correct: voucherTypeCorrect,
    error_code: voucherTypeCorrect ? null : 'VOUCHER_TYPE_WRONG',
  });

  diffs.push(diffGst(voucher, expected, expectedLegs, sequence, options));
  diffs.push(diffTds(voucher, expected, expectedLegs, sequence, options));
  diffs.push(diffBillReference(voucher, expectedLegs, sequence, options));
  // Narration is scored for ONE thing only (2026-09-10 meeting): a bank
  // voucher's narration must carry the bank statement's transaction
  // reference, copied as printed. Nothing else about narration is judged,
  // and narration_discipline stays a retired concept.
  const bankReferenceDiff = diffBankReference(voucher, expectedLegs, sequence);
  if (bankReferenceDiff) {
    diffs.push(bankReferenceDiff);
  }

  return diffs;
}

// The statement reference the key's narration was rewritten to carry
// (build-bank-statement.ts applyBankReferences: "... via bank, Ref
// NEFT/N24042601/KAREMP/INV-005."). Only transactions whose key narration
// names such a reference are checked; a text-mode batch has none.
// Only a statement-shaped reference counts: it carries the stamp (the
// N/CD/CW code with the date and line number). "Ref INV-012" in a key
// narration is a bill number, not a bank reference, and is not checked.
// 2026-09-17, second round: the statement joins the bills one movement
// settles with " & " (build-bank-statement.ts BILL_SEPARATOR), so "&" is in
// both character classes; a bill number may carry "." or lower case
// ("inv.12"), so the reference ends only at ", " or a final "."; and the
// stamp is the date plus the sequence padded to two digits, so sequence 100
// and later print 9 digits (N240416101).
const KEY_BANK_REFERENCE = /\bRef\s+([A-Za-z0-9][A-Za-z0-9 &.\/\-]*?(?:N|CD|CW)\d{8,9}(?:[\/ ][A-Za-z0-9 &.\/\-]*?)?)(?=,\s|\.?\s*$)/;
// The learner may paste the whole reference or just its distinctive stamp.
const REFERENCE_STAMP = /\b(?:N|CD|CW)\d{8,9}\b/i;

export function keyBankReference(narration: string | null | undefined): string | null {
  const match = KEY_BANK_REFERENCE.exec(narration ?? '');
  return match ? match[1].trim() : null;
}

function diffBankReference(voucher: Voucher, expectedLegs: AnswerKeyEntry[], voucherRef: number): VoucherDiff | null {
  const reference = expectedLegs.map((leg) => keyBankReference(leg.narration)).find((found): found is string => found !== null);
  if (!reference) {
    return null;
  }
  const stamp = REFERENCE_STAMP.exec(reference)?.[0] ?? null;
  const posted = voucher.narration.replace(/\s+/g, '').toLowerCase();
  const present =
    posted.includes(reference.replace(/\s+/g, '').toLowerCase()) ||
    (stamp !== null && posted.includes(stamp.toLowerCase()));
  return {
    voucherRef,
    field: 'narration',
    expected_masked: true,
    is_correct: present,
    error_code: present ? null : 'NARRATION_MISSING',
  };
}

// Inference for the "unexpected tax" checks must ignore ledger entries that
// ARE the transaction's own expected legs: a TDS-deposit payment's main
// account is a TDS Payable ledger, and the GST set-off JV's legs are all
// GST ledgers — flagging those as "unexpected GST/TDS" penalized correct
// postings (pilot calibration, 2026-08-20).
function entriesBeyondExpectedLegs(voucher: Voucher, expectedLegs: AnswerKeyEntry[], options: ScoringOptions = {}): LedgerEntry[] {
  return voucher.ledgerEntries.filter((entry) => !expectedLegs.some((leg) => legMatchesEntry(entry, leg, options)));
}

function diffGst(
  voucher: Voucher,
  expected: AnswerKeyEntry,
  expectedLegs: AnswerKeyEntry[],
  voucherRef: number,
  options: ScoringOptions = {},
): VoucherDiff {
  const actualGst = collectGstFromLedgerEntries(
    expected.gst_head === null ? entriesBeyondExpectedLegs(voucher, expectedLegs, options) : voucher.ledgerEntries,
  );

  if (expected.gst_head === null) {
    // No GST applies to this transaction. Posting none is correct and scores
    // as such, but it is vacuous — nothing was actually demonstrated — so it
    // is excluded from coaching praise (see VoucherDiffSchema).
    return {
      voucherRef,
      field: 'gst',
      expected_masked: true,
      is_correct: actualGst.heads.size === 0,
      vacuously_correct: actualGst.heads.size === 0,
      error_code: actualGst.heads.size === 0 ? null : 'GST_UNEXPECTED',
    };
  }

  if (actualGst.heads.size === 0) {
    return {
      voucherRef,
      field: 'gst',
      expected_masked: true,
      is_correct: false,
      error_code: 'GST_MISSING',
    };
  }

  // Intra-state GST is a CGST+SGST PAIR posted as two ledgers; the answer key
  // carries one head ('CGST' by convention). Correct means the COMPLETE right
  // regime: both CGST and SGST present (in either order) with no IGST for
  // intra-state, or IGST alone for inter-state. A half-posted pair (CGST
  // entered twice, SGST absent — a real pilot submission) is Appendix A E05
  // "CGST/SGST split missed" and maps to GST_MISSING; the wrong regime
  // entirely stays GST_HEAD_WRONG.
  const expectedIntraState = expected.gst_head === 'CGST' || expected.gst_head === 'SGST';
  // A month-end set-off journal legitimately touches every head — output
  // CGST/SGST/IGST against input CGST/SGST/IGST — so the one-regime rule
  // below would call a correct set-off GST_HEAD_WRONG (Praveen's February,
  // 2026-09-07). When the key's own legs span both regimes, correct means
  // every head the key names is present.
  const expectedHeads = new Set(expectedLegs.map((leg) => leg.gst_head).filter((head): head is 'CGST' | 'SGST' | 'IGST' => head !== null));
  const expectedMixedRegime = expectedHeads.has('IGST') && (expectedHeads.has('CGST') || expectedHeads.has('SGST'));
  const headCorrect = expectedMixedRegime
    ? [...expectedHeads].every((head) => actualGst.heads.has(head))
    : expectedIntraState
      ? actualGst.heads.has('CGST') && actualGst.heads.has('SGST') && !actualGst.heads.has('IGST')
      : actualGst.heads.has('IGST') && !actualGst.heads.has('CGST') && !actualGst.heads.has('SGST');

  // Side check (Input vs Output) only when the learner's ledger name states
  // a side AND the voucher type implies one — silent otherwise, so plain
  // "IGST Payable"-style naming isn't penalized. Any stated side that
  // contradicts the required one (an Output GST leg on a purchase, an Input
  // GST leg on a sale) fails the check.
  const requiredSide = expectedGstSide(expected.voucher_type);
  const sideWrong = requiredSide !== null && [...actualGst.sides].some((side) => side !== requiredSide);

  // Amount check (2026-09-10): the right heads on the right side with the
  // wrong tax figure used to pass silently (GST_RATE_WRONG was never
  // raised). On a sales-/purchase-side voucher the posted total per head
  // must equal the key's GST legs per head, to the rupee. Set-off journals
  // carry both sides of a head and are judged on heads only.
  const amountsWrong = requiredSide !== null && !gstAmountsMatch(voucher, expectedLegs);

  const gstCorrect = headCorrect && !sideWrong && !amountsWrong;
  const splitMissed =
    expectedIntraState &&
    !actualGst.heads.has('IGST') &&
    actualGst.heads.has('CGST') !== actualGst.heads.has('SGST');
  return {
    voucherRef,
    field: 'gst',
    expected_masked: true,
    is_correct: gstCorrect,
    error_code: gstCorrect
      ? null
      : !headCorrect || sideWrong
        ? splitMissed && !sideWrong
          ? 'GST_MISSING'
          : 'GST_HEAD_WRONG'
        : 'GST_RATE_WRONG',
  };
}

const GST_AMOUNT_TOLERANCE = 1;

// Posted GST per head versus the key's GST legs per head. A key with no GST
// leg amounts (older single-leg keys carried the tax as metadata) is not
// amount-checked.
function gstAmountsMatch(voucher: Voucher, expectedLegs: AnswerKeyEntry[]): boolean {
  const expectedByHead = new Map<string, number>();
  for (const leg of expectedLegs) {
    if (leg.gst_head && gstHeadOf(leg.correct_account) !== null) {
      expectedByHead.set(leg.gst_head, (expectedByHead.get(leg.gst_head) ?? 0) + leg.amount);
    }
  }
  if (expectedByHead.size === 0) return true;
  const actualByHead = new Map<string, number>();
  for (const entry of voucher.ledgerEntries) {
    const head = gstHeadOf(entry.ledgerName)?.toUpperCase();
    if (head) actualByHead.set(head, (actualByHead.get(head) ?? 0) + entry.amount);
  }
  for (const [head, expectedAmount] of expectedByHead) {
    if (Math.abs((actualByHead.get(head) ?? 0) - expectedAmount) >= GST_AMOUNT_TOLERANCE) return false;
  }
  return true;
}

function diffTds(
  voucher: Voucher,
  expected: AnswerKeyEntry,
  expectedLegs: AnswerKeyEntry[],
  voucherRef: number,
  options: ScoringOptions = {},
): VoucherDiff {
  const actualTds = inferTdsFromLedgerEntries(
    expected.tds_section === null ? entriesBeyondExpectedLegs(voucher, expectedLegs, options) : voucher.ledgerEntries,
  );

  if (expected.tds_section === null) {
    // No TDS applies — vacuously correct when none was posted, same reasoning
    // as diffGst's equivalent branch above.
    return {
      voucherRef,
      field: 'tds',
      expected_masked: true,
      is_correct: actualTds === null,
      vacuously_correct: actualTds === null,
      error_code: actualTds === null ? null : 'TDS_UNEXPECTED',
    };
  }

  return {
    voucherRef,
    field: 'tds',
    expected_masked: true,
    is_correct: actualTds !== null,
    error_code: actualTds !== null ? null : 'TDS_MISSING',
  };
}

// Bill references (rewritten 2026-09-17). The old rule accepted a match when
// either normalised string CONTAINED the other and when ANY one reference
// overlapped: a posted "1", "0" or "INV" passed for INV-001, INV-010 for a
// key INV-01, DT-115 for DT-11; "MS-B1, MS-B2, MS-B3 (part)" passed on MS-B1
// alone; an allocation on the bank leg counted; and "INV-18" failed against
// "INV-018". References are now TOKENS compared for exact equality after
// formatting is removed:
//   - annotations go: "(part)", "(bal)", "(Advance)", "dt 04-May", the
//     "Agst Ref" / "New Ref" / "Against" / "Ref" prefixes (parseBillReferences
//     in company.ts splits a key string and strips the prefixes);
//   - case and punctuation are ignored, and leading zeros inside a numeric
//     group are dropped: INV-18 = INV-018 = inv 018, but INV-1-01 stays
//     INV-1-1 and never equals INV-11 (groups keep their boundaries);
//   - the reference words "New Ref", "Agst Ref", "Advance", "On Account"
//     alone are types, not numbers.
// Every expected reference must be allocated on the PARTY leg of the voucher
// (the leg the key's party sits on; or the legs carrying references when no
// party can be told). A reference allocated there that the key does not name
// is wrong too (money set against the wrong bill), with one exception: an
// advance, i.e. a reference the batch raises as an advance, or an allocation
// Tally typed "Advance". Pack seq 87 applies advance ADV-01 against INV-009
// while its key string names only INV-009, and the reviewer's note says that
// is the correct posting. Allocations on other legs are ignored. BILLTYPE is
// read but never required: an expected reference is satisfied by its number
// whatever type the learner chose (so an advance may be New Ref or Advance),
// and an "On Account" allocation is not a reference.
const PLACEHOLDER_REFERENCE = /^(NEWREF|NEWREFERENCE|AGSTREF|AGAINSTREF|ADVANCE|ONACCOUNT|REF|NA|NIL)$/;

// A bank ledger or Cash carrying a reference is never the party.
const CASH_LEDGER = /^cash\b|cash-in-hand/i;

export function canonicalBillReference(reference: string): string | null {
  const bare = reference
    .replace(/\([^)]*\)/g, ' ')
    .trim()
    // "Ref INV-012", "Ref: 45", "Reference No. 7" (never "REF-001" itself)
    .replace(/^ref(?:erence)?(?:[.:]|\s)+/i, '')
    // "INV-025 dt 04-May", "INV-7 dated 4/5": a date after the number
    .replace(/(?<=\S)\s+(?:dt\.?|dated)\s*[:-]?\s*\d.*$/i, '')
    .replace(/(?<![a-z])(?:no|number|num)\b\.?/gi, ' ')
    .replace(/#/g, ' ');
  const groups = bare.toUpperCase().match(/[A-Z]+|\d+/g);
  if (!groups) return null;
  const canonical = groups.map((group) => (/^\d+$/.test(group) ? group.replace(/^0+(?=\d)/, '') : group)).join('-');
  return PLACEHOLDER_REFERENCE.test(canonical.replace(/-/g, '')) ? null : canonical;
}

// The tokens a key's bill_reference (or a learner's allocation name) names.
export function billReferenceTokens(reference: string | null | undefined): Set<string> {
  const tokens = new Set<string>();
  for (const parsed of parseBillReferences(reference)) {
    if (parsed.kind === 'on_account') continue;
    const canonical = canonicalBillReference(parsed.ref);
    if (canonical) tokens.add(canonical);
  }
  return tokens;
}

type AllocationTokens = { tokens: Set<string>; advanceTokens: Set<string>; allocations: number };

function allocationTokens(entries: LedgerEntry[]): AllocationTokens {
  const tokens = new Set<string>();
  const advanceTokens = new Set<string>();
  let allocations = 0;
  for (const entry of entries) {
    for (const allocation of entry.billAllocations) {
      const billType = allocation.billType?.trim() ?? '';
      if (/^on\s*account$/i.test(billType)) {
        allocations += 1;
        continue;
      }
      if (allocation.name.trim().length === 0) continue;
      allocations += 1;
      for (const token of billReferenceTokens(allocation.name)) {
        tokens.add(token);
        if (/^advance$/i.test(billType)) advanceTokens.add(token);
      }
    }
  }
  return { tokens, advanceTokens, allocations };
}

// Every reference the batch marks as an advance ("(Advance)", ADV-...).
export function advanceReferencesOf(answerKey: AnswerKey): Set<string> {
  const advances = new Set<string>();
  for (const entry of answerKey.entries) {
    for (const parsed of parseBillReferences(entry.bill_reference)) {
      if (parsed.kind !== 'advance') continue;
      const canonical = canonicalBillReference(parsed.ref);
      if (canonical) advances.add(canonical);
    }
  }
  return advances;
}

// The consolidated legs whose posted entries must carry the references.
export function referenceLegIndexes(legs: AnswerKeyEntry[]): Set<number> {
  // The party is found by side and name whichever leg the key stamped the
  // reference on (generated keys stamp only one leg, packs every leg).
  const parties = partyAccountsOf(legs.map((leg) => ({ ...leg, bill_reference: leg.bill_reference ?? '' })));
  const party = new Set<number>();
  legs.forEach((leg, index) => {
    const name = leg.correct_account;
    if (parties.has(normalizeAccountName(name)) && !isBankLedger(name) && !CASH_LEDGER.test(name)) party.add(index);
  });
  if (party.size > 0) return party;
  const withReference = new Set<number>();
  legs.forEach((leg, index) => {
    if (leg.bill_reference !== null) withReference.add(index);
  });
  return withReference;
}

// The posted entries a transaction's references are read from: the entries
// paired with its party legs, plus any entry left unpaired on a party leg's
// side (a party posted under a wrong name still carries its allocations; the
// account finding covers the name).
export function referenceEntries(pairing: LegPairing): LedgerEntry[] {
  const indexes = referenceLegIndexes(pairing.legs);
  const sides = new Set([...indexes].map((index) => pairing.legs[index].dr_cr));
  const paired = [...indexes].map((index) => pairing.assigned.get(index)).filter((entry): entry is LedgerEntry => entry !== undefined);
  return [...paired, ...pairing.leftover.filter((entry) => sides.has(entry.drOrCr))];
}

// A credit or debit note may carry either its own number or the number of
// the bill it is raised against. The key uses both conventions (the pack's
// credit note seq 43 names INV-001, the invoice it reverses; debit note seq
// 51 names DN-M1, the note itself), so either is accepted, but only when the
// key LINKS the two: the other number must appear in the key's narration
// ("Debit note DN-M1 against MS-B1"). Pack seq 51's narration names only
// DN-M1, so an allocation "Agst Ref MS-B1" there stays BILL_REFERENCE_WRONG:
// nothing in the key says DN-M1 was raised against MS-B1 (2026-09-17).
const NARRATION_REFERENCE = /\b[A-Z]{1,6}\d*(?:[-/][A-Z0-9]+)+\b/g;

function linkedNoteReferences(expectedLegs: AnswerKeyEntry[], expectedTokens: Set<string>): Set<string> {
  const type = baseVoucherType(expectedLegs[0].voucher_type);
  const linked = new Set<string>();
  if (type !== 'credit note' && type !== 'debit note') return linked;
  for (const leg of expectedLegs) {
    for (const match of (leg.narration ?? '').matchAll(NARRATION_REFERENCE)) {
      if (!/\d/.test(match[0])) continue;
      const canonical = canonicalBillReference(match[0]);
      if (canonical && !expectedTokens.has(canonical)) linked.add(canonical);
    }
  }
  return linked;
}

function covers(posted: Set<string>, required: Set<string>): boolean {
  return required.size > 0 && [...required].every((token) => posted.has(token));
}

export function billReferencesCorrect(
  expectedLegs: AnswerKeyEntry[],
  posted: Pick<AllocationTokens, 'tokens' | 'advanceTokens'>,
  advanceReferences: ReadonlySet<string> = new Set(),
): boolean {
  const expectedTokens = new Set<string>();
  for (const leg of expectedLegs) {
    for (const token of billReferenceTokens(leg.bill_reference)) expectedTokens.add(token);
  }
  const linked = linkedNoteReferences(expectedLegs, expectedTokens);
  const nothingExtra = [...posted.tokens].every(
    (token) => expectedTokens.has(token) || linked.has(token) || advanceReferences.has(token) || posted.advanceTokens.has(token),
  );
  return nothingExtra && (covers(posted.tokens, expectedTokens) || covers(posted.tokens, linked));
}

function diffBillReference(
  voucher: Voucher,
  expectedLegs: AnswerKeyEntry[],
  voucherRef: number,
  options: ScoringOptions = {},
): VoucherDiff {
  const correct: VoucherDiff = { voucherRef, field: 'bill_reference', expected_masked: true, is_correct: true, error_code: null };
  if (expectedLegs.every((leg) => leg.bill_reference === null)) {
    return correct;
  }

  const posted = allocationTokens(referenceEntries(pairLegsToEntries(voucher, expectedLegs, options)));
  if (posted.allocations === 0) {
    return { ...correct, is_correct: false, error_code: 'BILL_REFERENCE_MISSING' };
  }

  // The key named only a reference TYPE ("New Ref (advance)") because the
  // brief gave no bill number — a suspense reclassified as a customer
  // advance (Praveen's February #12, 2026-09-07). Any allocation the learner
  // created is then the right answer; there is no number to compare.
  const expectedTokens = expectedLegs.flatMap((leg) => [...billReferenceTokens(leg.bill_reference)]);
  if (expectedTokens.length === 0) {
    return correct;
  }

  return billReferencesCorrect(expectedLegs, posted, options.advanceReferences)
    ? correct
    : { ...correct, is_correct: false, error_code: 'BILL_REFERENCE_WRONG' };
}

function amountsMatch(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 0.005;
}

// Submission-level penalties (2026-09-10): every ledger set-up finding and
// every blank or duplicate voucher costs one standard field's weight, added
// to the denominator and never earned. Extra and reversal vouchers are
// reported but cost nothing: they may be legitimate corrections.
function submissionPenaltyWeight(unmatched: UnmatchedVoucher[], findings: LedgerFinding[]): number {
  const voucherPenalties = unmatched.filter((voucher) => voucher.kind === 'blank' || voucher.kind === 'duplicate').length;
  return (voucherPenalties + findings.length) * STANDARD_WEIGHT;
}

function computeWeightedScore(diffs: VoucherDiff[], penaltyWeight = 0): number {
  let totalWeight = penaltyWeight;
  let earnedWeight = 0;

  for (const diff of diffs) {
    const weight = diff.weight ?? FIELD_WEIGHT[diff.field];
    totalWeight += weight;
    if (diff.is_correct) {
      earnedWeight += weight;
    }
  }

  return totalWeight === 0 ? 0 : earnedWeight / totalWeight;
}

export function computeOverallResult(weightedScore: number, tbTieOut: boolean): 'pass' | 'partial' | 'fail' {
  if (!tbTieOut) {
    return weightedScore >= PASS_THRESHOLD ? 'partial' : 'fail';
  }
  if (weightedScore >= PASS_THRESHOLD) {
    return 'pass';
  }
  if (weightedScore >= PARTIAL_THRESHOLD) {
    return 'partial';
  }
  return 'fail';
}

// Trial Balance tie-out (movement-based since 2026-09-09).
//
// Does the learner's Trial Balance move the way the correct postings would
// have moved it? With a previous scored Trial Balance available, each
// account's MOVEMENT (this export's closing minus the previous export's
// closing) is compared to the batch's answer-key legs netted per account.
// Past mistakes sit in both the opening and the closing and cancel out, so
// a clean month ties out even in books that drifted months ago. The
// closing-balance comparison it replaces failed every learner forever
// after their first slip (all three interns were capped at 'partial' for
// the whole programme, and the Trial Balance concept could never be
// mastered). Without a previous Trial Balance (the first scored
// submission) the closing comparison still applies: opening balances from
// the authored pack plus this key's legs must equal the export's closing.
//
// GST- and TDS-named accounts are exempt: learners name and split those
// ledgers in every way ("CGST" for both input and output, "Input CGST 9%"),
// and GST/TDS correctness is scored per voucher by diffGst/diffTds. A
// fully-settled account legitimately absent from the export only fails when
// its expected figure is non-zero. Mismatches are returned by ledger with
// the size of the gap, never the expected figure.
const TIE_OUT_EXEMPT_PATTERN = /gst|tds/i;
// Whole-rupee tolerance: Tally rounds TDS/GST legs, and a movement is the
// difference of two rounded closings.
const TIE_OUT_TOLERANCE = 1;

export type TrialBalanceTieOut = { tieOut: boolean; mismatches: TieOutMismatch[] };

export function signedOpening(rows: ParsedTrialBalance['ledgers']): number {
  return rows.reduce((sum, row) => sum + ((row.openingDebit ?? 0) - (row.openingCredit ?? 0)), 0);
}

// An export carries Tally's opening column when any row has it (the
// parser sets both fields, zero for a blank tag, whenever the tag exists —
// including on a signed row whose closing is blank, since 2026-09-16).
export function hasOpeningColumn(trialBalance: ParsedTrialBalance): boolean {
  return trialBalance.ledgers.some((row) => row.openingDebit !== undefined || row.openingCredit !== undefined);
}

export function signedClosing(rows: ParsedTrialBalance['ledgers']): number {
  return rows.reduce((sum, row) => sum + (row.closingDebit - row.closingCredit), 0);
}

// Every export row that stands for `account`: exact name (or alias) matches,
// plus the fuzzy rows no other expected account has claimed (the caller's
// `excluded` set: rows claimed exactly, and rows reserved for another
// account by fuzzilyReservedRows). A
// learner may split one logical account across ledgers ("Credit Sales A/c"
// + "Cash Sales A/c" where the key says "Sales"; "Deccan Traders" +
// "Deccan Traders Debtor" for a party that both buys and sells, Praveen
// 2026-09-09) — their SUM is what must tie out. Exact claims come first so
// "Sales" never swallows a "Sales Returns" row the key expects separately
// (2026-09-02); an unclaimed returns row cannot be swallowed either, since
// accountNamesMatch refuses to equate a returns ledger with its base.
const MIN_CONTAINMENT_CHARS = 5;

// Tally's own account groups (2026-09-11). A partially expanded export
// lists a group next to its ledgers ("Sales Accounts" above "SALES"), and
// the group row would be counted a second time for the ledger it embeds.
// Group rows carry no ledger of the learner's, so they never take part.
// "Suspense A/c" is deliberately absent: learners name their suspense
// LEDGER exactly like the group (Garima's "SUSPENSE AC", 2026-09-11), and
// the correct books carry a balance on it.
const TALLY_GROUP_NAMES = new Set(
  [
    'Capital Account', 'Current Liabilities', 'Duties & Taxes', 'Sundry Creditors', 'Provisions', 'Loans (Liability)',
    'Bank OD A/c', 'Bank OCC A/c', 'Secured Loans', 'Unsecured Loans', 'Reserves & Surplus', 'Retained Earnings',
    'Fixed Assets', 'Current Assets', 'Sundry Debtors', 'Cash-in-Hand', 'Bank Accounts', 'Deposits (Asset)',
    'Loans & Advances (Asset)', 'Stock-in-Hand', 'Investments', 'Misc. Expenses (ASSET)', 'Branch / Divisions',
    'Sales Accounts', 'Purchase Accounts', 'Direct Expenses', 'Direct Incomes', 'Indirect Expenses',
    'Indirect Incomes', 'Expenses (Direct)', 'Expenses (Indirect)', 'Income (Direct)', 'Income (Indirect)',
    'Opening Stock', 'Closing Stock', 'Profit & Loss A/c',
  ].map(normalizeAccountName),
);

export function isTallyGroupRow(ledgerName: string): boolean {
  return TALLY_GROUP_NAMES.has(normalizeAccountName(ledgerName));
}

export function rowsForAccount(
  trialBalance: ParsedTrialBalance,
  acceptableNames: string[],
  excluded: Set<string>,
): ParsedTrialBalance['ledgers'] {
  const normalizedNames = acceptableNames.map(normalizeAccountName);
  const ledgerRows = trialBalance.ledgers.filter((ledger) => !isTallyGroupRow(ledger.ledgerName));
  const exactRows = ledgerRows.filter((ledger) => normalizedNames.includes(normalizeAccountName(ledger.ledgerName)));
  const unclaimed = ledgerRows.filter((ledger) => !excluded.has(ledger.ledgerName));
  if (exactRows.length > 0) {
    // Alongside an exact row, only rows whose name EMBEDS the account name
    // count as the same account split in two ("Deccan Traders Debtor" for
    // "Deccan Traders"). The wider typo/token matching is too loose to add
    // to a row already found by name.
    const embedding = unclaimed.filter((ledger) => {
      const rowName = normalizeAccountName(ledger.ledgerName);
      return (
        !exactRows.includes(ledger) &&
        acceptableNames.some((name) => {
          const needle = normalizeAccountName(name);
          return needle.length >= MIN_CONTAINMENT_CHARS && rowName.includes(needle) && aliasFitsAccount(ledger.ledgerName, name);
        })
      );
    });
    return [...exactRows, ...embedding];
  }
  return unclaimed.filter((ledger) => acceptableNames.some((name) => accountNamesMatch(ledger.ledgerName, name)));
}

// A previous export with fewer rows than this is a collapsed, group-level
// Trial Balance (the pilot diagnostic exports were two-group files), not a
// per-ledger baseline: measuring this month's movement from it would read
// every ledger as having started at zero. Such a baseline is ignored and
// the closing comparison applies instead.
const MIN_BASELINE_ROWS = 12;

export function exactlyClaimedRows(trialBalance: ParsedTrialBalance, namesByAccount: Map<string, string[]>): Set<string> {
  const claimed = new Set<string>();
  for (const names of namesByAccount.values()) {
    const normalized = names.map(normalizeAccountName);
    for (const ledger of trialBalance.ledgers) {
      if (normalized.includes(normalizeAccountName(ledger.ledgerName))) claimed.add(ledger.ledgerName);
    }
  }
  return claimed;
}

// Fuzzy rows reserved for their owner (2026-09-16). A row no account claims
// exactly is reserved for the one expected account whose OWN name (the
// first name in its list, never an alias) matches it. Without the
// reservation an alias could take a row that plainly belongs to another
// account: Advertisement & Marketing's alias "Advertising" is embedded in
// "Signage Advertising (firm)", the vendor row of the expected account
// "Signage Advertising", and Template595's Rs 216 vendor balance was read
// as an expense mismatch. A row matching two or more accounts by own name
// is left unreserved (no owner can be told apart). Returns ledger name →
// owning account key.
export function fuzzilyReservedRows(trialBalance: ParsedTrialBalance, namesByAccount: Map<string, string[]>): Map<string, string> {
  const claimed = exactlyClaimedRows(trialBalance, namesByAccount);
  const reserved = new Map<string, string>();
  for (const ledger of trialBalance.ledgers) {
    if (claimed.has(ledger.ledgerName) || isTallyGroupRow(ledger.ledgerName)) continue;
    const owners = [...namesByAccount.entries()]
      .filter(([account, names]) => accountNamesMatch(ledger.ledgerName, names[0] ?? account))
      .map(([account]) => account);
    if (owners.length === 1) reserved.set(ledger.ledgerName, owners[0]);
  }
  return reserved;
}

// The rows `account` may not take: every exactly claimed row, and every row
// reserved for a different account. Its own reserved rows stay open to it,
// so a split party ("Deccan Traders Debtor") still sums with its exact row.
export function rowsExcludedFor(account: string, claimed: Set<string>, reserved: Map<string, string>): Set<string> {
  const excluded = new Set(claimed);
  for (const [ledgerName, owner] of reserved) {
    if (owner !== account) excluded.add(ledgerName);
  }
  return excluded;
}

// Financial-year change (2026-09-11): Tally restarts every profit-and-loss
// ledger on 1 April, so the first batch of a year exports Sales, Purchases
// and the expense ledgers with that month's figures only while the
// baseline (31 March) carries the whole previous year — Garima's April
// read "Sales off by Rs 32,11,000", her 2024-25 total. In that month a
// profit-and-loss ledger's movement is its closing figure itself; a
// learner who exports the whole period since books began (cumulative
// figures) is accepted as well, whichever reading matches. Balance-sheet
// ledgers (parties, cash, bank, assets, capital, accruals) carry on.
export function evaluateTrialBalanceTieOut(
  trialBalance: ParsedTrialBalance,
  answerKey: AnswerKey,
  previousExport: ParsedTrialBalance | null,
  options: { firstMonthOfFinancialYear?: boolean } = {},
): TrialBalanceTieOut {
  // Self-contained movement (2026-09-11): when the export carries Tally's
  // opening column for the period, the month's movement is its closing
  // minus its opening, read from the same file. Nothing stored from an
  // earlier month is needed, so a learner who corrects an old month after
  // feedback (the right thing to do) is measured on this month alone —
  // Praveen's SA/2027-04 fix in April would otherwise have surfaced as a
  // May movement. The previous-export comparison remains for files with
  // no opening column.
  const selfContained = hasOpeningColumn(trialBalance);
  const previousTrialBalance =
    !selfContained && previousExport && previousExport.ledgers.length >= MIN_BASELINE_ROWS ? previousExport : null;
  const movementBased = selfContained || previousTrialBalance !== null;
  const expected = new Map<string, number>();
  const aliasesByAccount = new Map<string, string[]>();
  const partyAccounts = partyAccountsOf(answerKey.entries);

  if (!movementBased) {
    for (const opening of answerKey.opening_balances ?? []) {
      const key = opening.account.trim().toLowerCase();
      expected.set(key, (expected.get(key) ?? 0) + (opening.dr_cr === 'Dr' ? opening.amount : -opening.amount));
    }
  }
  for (const entry of answerKey.entries) {
    const key = entry.correct_account.trim().toLowerCase();
    expected.set(key, (expected.get(key) ?? 0) + (entry.dr_cr === 'Dr' ? entry.amount : -entry.amount));
    if (entry.account_aliases?.length) {
      // A returns ledger never borrows its base ledger's name as an alias.
      aliasesByAccount.set(key, entry.account_aliases.filter((alias) => aliasFitsAccount(alias, entry.correct_account)));
    }
  }

  const namesByAccount = new Map<string, string[]>();
  for (const account of expected.keys()) namesByAccount.set(account, [account, ...(aliasesByAccount.get(account) ?? [])]);
  const claimedNow = exactlyClaimedRows(trialBalance, namesByAccount);
  const claimedBefore = previousTrialBalance ? exactlyClaimedRows(previousTrialBalance, namesByAccount) : new Set<string>();
  const reservedNow = fuzzilyReservedRows(trialBalance, namesByAccount);
  const reservedBefore = previousTrialBalance ? fuzzilyReservedRows(previousTrialBalance, namesByAccount) : new Map<string, string>();

  const mismatches: TieOutMismatch[] = [];
  for (const [account, expectedFigure] of expected) {
    if (TIE_OUT_EXEMPT_PATTERN.test(account)) continue;
    const names = namesByAccount.get(account) ?? [account];
    const rowsNow = rowsForAccount(trialBalance, names, rowsExcludedFor(account, claimedNow, reservedNow));
    if (selfContained) {
      // Tally leaves out a ledger with no movement and a nil balance, so
      // an absent row is a movement of zero.
      if (rowsNow.length === 0) {
        if (Math.abs(expectedFigure) >= TIE_OUT_TOLERANCE) {
          mismatches.push({ account, status: 'missing', difference: -expectedFigure });
        }
        continue;
      }
      const difference = Math.round((signedClosing(rowsNow) - signedOpening(rowsNow) - expectedFigure) * 100) / 100;
      if (Math.abs(difference) >= TIE_OUT_TOLERANCE) {
        mismatches.push({ account, status: 'off', difference });
      }
      continue;
    }
    const rowsBefore = previousTrialBalance
      ? rowsForAccount(previousTrialBalance, names, rowsExcludedFor(account, claimedBefore, reservedBefore))
      : [];
    if (rowsNow.length === 0 && rowsBefore.length === 0) {
      if (Math.abs(expectedFigure) >= TIE_OUT_TOLERANCE) {
        mismatches.push({ account, status: 'missing', difference: -expectedFigure });
      }
      continue;
    }
    const restartsThisMonth =
      options.firstMonthOfFinancialYear === true && movementBased && classifyLedger(account, partyAccounts) === 'profit_and_loss';
    if (restartsThisMonth) {
      const fromZero = Math.round((signedClosing(rowsNow) - expectedFigure) * 100) / 100;
      const cumulative = Math.round((signedClosing(rowsNow) - signedClosing(rowsBefore) - expectedFigure) * 100) / 100;
      const difference = Math.abs(fromZero) <= Math.abs(cumulative) ? fromZero : cumulative;
      if (Math.abs(difference) >= TIE_OUT_TOLERANCE) {
        mismatches.push({ account, status: 'off', difference });
      }
      continue;
    }
    const actual = signedClosing(rowsNow) - (movementBased ? signedClosing(rowsBefore) : 0);
    const difference = Math.round((actual - expectedFigure) * 100) / 100;
    if (Math.abs(difference) >= TIE_OUT_TOLERANCE) {
      mismatches.push({ account, status: 'off', difference });
    }
  }

  return { tieOut: mismatches.length === 0, mismatches };
}

// Rolls per-voucher diffs up to a per-concept pass/fail (Unit 09). A
// transaction "passes" for a concept if every scored field diffed for that
// transaction (sequence) is correct — same all-fields-correct bar the
// diagnostic uses for a clean voucher. A concept tagged on more than one
// transaction in this exercise fails overall if any occurrence fails, since
// a single wrong application means the concept isn't reliably applied yet.
const CONCEPT_PASS_RATIO = 0.9;

const VOUCHER_STRUCTURE_FIELDS: ScoredField[] = ['account', 'dr_cr', 'amount', 'voucher_type'];

const CONCEPT_FIELDS: Record<ConceptTag, ScoredField[]> = {
  sales_voucher_basics: VOUCHER_STRUCTURE_FIELDS,
  purchase_voucher_basics: VOUCHER_STRUCTURE_FIELDS,
  payment_voucher_basics: VOUCHER_STRUCTURE_FIELDS,
  receipt_voucher_basics: VOUCHER_STRUCTURE_FIELDS,
  contra_voucher_basics: VOUCHER_STRUCTURE_FIELDS,
  journal_voucher_basics: VOUCHER_STRUCTURE_FIELDS,
  gst_classification: ['gst'],
  tds_classification: ['tds'],
  bill_by_bill_referencing: ['bill_reference'],
  narration_discipline: ['narration'],
  trial_balance_tie_out: VOUCHER_STRUCTURE_FIELDS,
  // Rulebook-section concepts (2026-09-10).
  customer_advance: [...VOUCHER_STRUCTURE_FIELDS, 'bill_reference', 'gst'],
  supplier_advance: [...VOUCHER_STRUCTURE_FIELDS, 'bill_reference', 'tds'],
  on_account_reference: [...VOUCHER_STRUCTURE_FIELDS, 'bill_reference'],
  multi_bill_settlement: [...VOUCHER_STRUCTURE_FIELDS, 'bill_reference'],
  tds_on_receipt: [...VOUCHER_STRUCTURE_FIELDS, 'tds', 'bill_reference'],
  gst_set_off: [...VOUCHER_STRUCTURE_FIELDS, 'gst'],
  gst_payment: VOUCHER_STRUCTURE_FIELDS,
  rcm_and_late_fee: [...VOUCHER_STRUCTURE_FIELDS, 'gst'],
  fixed_assets_depreciation: [...VOUCHER_STRUCTURE_FIELDS, 'gst'],
};

function computeConceptResults(
  diffs: VoucherDiff[],
  transactionGroups: AnswerKeyEntry[][],
  tbTieOut: boolean,
): ConceptResult[] {
  // A concept is judged on the FIELDS it is about, not on every field of the
  // voucher. A payment whose only slip was a thin narration used to fail
  // payment_voucher_basics and bill_by_bill_referencing as well as
  // narration_discipline, and the coaching note then told Yeshas his bill
  // referencing and payment basics were "still slipping" when neither had a
  // single error (June, 2026-09-04). Narration, bill reference, GST and TDS
  // each own their field; the voucher-basics concepts own account, side,
  // amount and voucher type (a missing voucher lands there too).
  const relevantDiffs = (sequence: number, concept: ConceptTag): VoucherDiff[] =>
    diffs.filter((diff) => diff.voucherRef === sequence && CONCEPT_FIELDS[concept].includes(diff.field));

  // Proportional rollup: a concept passes when at least CONCEPT_PASS_RATIO
  // of its tagged transactions were fully clean. On a 1-3 transaction drill
  // this is identical to the old every-one-clean rule (one failure can never
  // stay at/above 90%); on a ~100-voucher pack it stops a single slip from
  // failing a concept the learner demonstrably applied correctly dozens of
  // times — the pilot reviewer called TDS "a real strength" on a submission
  // with one TDS-adjacent slip.
  const conceptCounts = new Map<ConceptTag, { passed: number; total: number }>();
  for (const group of transactionGroups) {
    const sequence = group[0].sequence;
    const conceptTags = new Set(group.flatMap((entry) => entry.concept_tags));

    for (const tag of conceptTags) {
      if (isRetiredConcept(tag)) continue;
      const scoped = relevantDiffs(sequence, tag);
      const passed = scoped.length > 0 && scoped.every((diff) => diff.is_correct);
      const counts = conceptCounts.get(tag) ?? { passed: 0, total: 0 };
      counts.total += 1;
      if (passed) {
        counts.passed += 1;
      }
      conceptCounts.set(tag, counts);
    }
  }

  const results: ConceptResult[] = [...conceptCounts.entries()].map(([concept_tag, counts]) => ({
    concept_tag,
    result: counts.passed / counts.total >= CONCEPT_PASS_RATIO ? 'pass' : 'fail',
  }));

  // The Trial Balance concept is about the Trial Balance (2026-09-09): every
  // scored posting logs an attempt on it, and it can only pass when the
  // export actually ties out. Before this it was judged only on the
  // structure of transactions that happened to carry the tag, so the flag
  // the learner saw in every feedback never reached their mastery.
  const tieOutIndex = results.findIndex((result) => result.concept_tag === 'trial_balance_tie_out');
  const structurePass = tieOutIndex === -1 ? true : results[tieOutIndex].result === 'pass';
  const tieOutResult: ConceptResult = { concept_tag: 'trial_balance_tie_out', result: tbTieOut && structurePass ? 'pass' : 'fail' };
  if (tieOutIndex === -1) results.push(tieOutResult);
  else results[tieOutIndex] = tieOutResult;

  return results;
}

// Pairs each expected transaction with the submitted voucher that best
// matches it, instead of assuming daybook position N is transaction N.
// Position-based matching breaks on realistic exports: a learner who posts
// two same-day vouchers in the other order would have every field of BOTH
// scored against the wrong key (added 2026-08-19 for the 98-voucher pack
// diagnostic, where positional drift would cascade through the whole month).
//
// Best score first over ALL pairs (2026-09-17). The earlier greedy pass let
// each transaction, in key order, take its best unused voucher, so an
// earlier transaction could take a voucher that was a far better fit for a
// later one: two Deccan Traders payments of 5,000 against DT/102 and DT/103
// posted in the other order were crossed, and an omitted sale took the same
// party's receipt. Every eligible (transaction, voucher) pair is now scored
// and pairs are accepted highest score first, ties broken by key order and
// then Day Book order (which preserves the old positional behaviour exactly
// when vouchers are indistinguishable).
//
// Signals: a distinctive account on the same side (strongest account
// signal), the same account on the other side (weaker), a generic account,
// matching amounts, the base voucher type, and two strong identifiers: a
// bill reference token the key names, and the statement reference or
// number the key's narration carries. The key has no date, so dates play no
// part (an Educational Mode export collapses them anyway).
//
// Generic ledger legs (Sales, Purchase, Cash, any bank, a GST/TDS head)
// prove nothing about WHICH transaction a voucher is. A pair is eligible
// only when the voucher type matches OR a distinctive leg matches on the
// same side, and it needs MIN_MATCH_SCORE of accumulated evidence. Without
// the bar, a transaction the learner never posted stole whichever unused
// voucher shared a generic "Purchase" leg, and every field of that innocent
// voucher was then flagged against the wrong key — the live 2026-08-31 pilot
// evaluation told the learner to "re-check GST on AI-201" when the truth was
// that the AI-201 purchase was never entered.
//
// A transaction with no qualifying match falls back to its positional
// voucher only when the submission has at most as many vouchers as the key
// has transactions (a short drill, where position is meaningful); on a pack
// export with extra vouchers it reports VOUCHER_MISSING instead.
const GENERIC_LEDGER_PATTERN = /^(sales|purchases?|cash|bank|output|input|c?gst|sgst|igst|tds|suspense|sales returns?|purchase returns?)\b/i;

function isGenericLedger(name: string): boolean {
  return GENERIC_LEDGER_PATTERN.test(name) || isBankLedger(name) || isTaxLedgerName(name) || CASH_LEDGER.test(name);
}

const DISTINCTIVE_ACCOUNT_SCORE = 4;
const OPPOSITE_SIDE_ACCOUNT_SCORE = 2;
const GENERIC_ACCOUNT_SCORE = 1;
const AMOUNT_SCORE = 1;
const VOUCHER_TYPE_SCORE = 1;
const REFERENCE_SCORE = 4;
const MIN_MATCH_SCORE = 4;

// Statement identifiers in a key narration: the documents-mode stamp
// (N24042601) and any run of 8+ digits (a UPI/NEFT number).
function narrationIdentifiers(expectedLegs: AnswerKeyEntry[]): string[] {
  const identifiers = new Set<string>();
  for (const leg of expectedLegs) {
    const narration = leg.narration ?? '';
    // 9 digits from sequence 100 on (2026-09-17, see KEY_BANK_REFERENCE).
    for (const match of narration.matchAll(/\b(?:N|CD|CW)\d{8,9}\b/gi)) identifiers.add(match[0].toLowerCase());
    for (const match of narration.matchAll(/\d{8,}/g)) identifiers.add(match[0]);
  }
  return [...identifiers];
}

export function matchVouchersToTransactions(
  vouchers: Voucher[],
  transactionGroups: AnswerKeyEntry[][],
  options: ScoringOptions = {},
): (Voucher | undefined)[] {
  return matchVouchersToTransactionsDetailed(vouchers, transactionGroups, options).matched;
}

export type VoucherMatching = {
  matched: (Voucher | undefined)[];
  matchedIndexes: (number | undefined)[];
  usedIndexes: Set<number>;
};

export function matchVouchersToTransactionsDetailed(
  vouchers: Voucher[],
  transactionGroups: AnswerKeyEntry[][],
  options: ScoringOptions = {},
): VoucherMatching {
  const used = new Set<number>();

  const signals = transactionGroups.map((expectedLegs) => ({
    references: new Set(expectedLegs.flatMap((leg) => [...billReferenceTokens(leg.bill_reference)])),
    identifiers: narrationIdentifiers(expectedLegs),
  }));
  const postedReferences = vouchers.map((voucher) => allocationTokens(voucher.ledgerEntries).tokens);

  function similarity(voucherIndex: number, transactionIndex: number): number | null {
    const voucher = vouchers[voucherIndex];
    const expectedLegs = transactionGroups[transactionIndex];
    let score = 0;
    let distinctiveSameSide = false;
    for (const leg of expectedLegs) {
      const matches = voucher.ledgerEntries.filter((entry) => legMatchesEntry(entry, leg, options));
      if (matches.length > 0) {
        if (isGenericLedger(leg.correct_account)) {
          score += GENERIC_ACCOUNT_SCORE;
        } else if (matches.some((entry) => entry.drOrCr === leg.dr_cr)) {
          score += DISTINCTIVE_ACCOUNT_SCORE;
          distinctiveSameSide = true;
        } else {
          score += OPPOSITE_SIDE_ACCOUNT_SCORE;
        }
      }
      if (voucher.ledgerEntries.some((entry) => amountsMatch(entry.amount, leg.amount))) {
        score += AMOUNT_SCORE;
      }
    }
    const typeMatches = sameVoucherType(voucher.voucherType, expectedLegs[0].voucher_type);
    if (!typeMatches && !distinctiveSameSide) {
      return null;
    }
    if (typeMatches) {
      score += VOUCHER_TYPE_SCORE;
    }
    const { references, identifiers } = signals[transactionIndex];
    if ([...references].some((token) => postedReferences[voucherIndex].has(token))) {
      score += REFERENCE_SCORE;
    }
    const narration = voucher.narration.toLowerCase();
    if (identifiers.some((identifier) => narration.includes(identifier))) {
      score += REFERENCE_SCORE;
    }
    return score;
  }

  const positionalFallbackAllowed = vouchers.length <= transactionGroups.length;

  // Two passes. Pass 1 matches every transaction it can on evidence. Pass 2
  // hands the still-unmatched transactions a positional fallback from the
  // vouchers still unused. Doing the fallback inside pass 1 let one MISSING
  // voucher swallow the next transaction's true voucher positionally, which
  // then cascaded down the whole batch: Garima's Level 4 export lacked
  // transaction 7 and previewed at 73% with five voucher-type errors that
  // were not hers (2026-09-03).
  const assigned: (number | undefined)[] = transactionGroups.map(() => undefined);

  const candidates: { score: number; transaction: number; voucher: number }[] = [];
  transactionGroups.forEach((_, transaction) => {
    for (let voucher = 0; voucher < vouchers.length; voucher++) {
      const score = similarity(voucher, transaction);
      if (score !== null && score >= MIN_MATCH_SCORE) {
        candidates.push({ score, transaction, voucher });
      }
    }
  });
  candidates.sort((a, b) => b.score - a.score || a.transaction - b.transaction || a.voucher - b.voucher);
  for (const candidate of candidates) {
    if (assigned[candidate.transaction] !== undefined || used.has(candidate.voucher)) continue;
    assigned[candidate.transaction] = candidate.voucher;
    used.add(candidate.voucher);
  }

  if (positionalFallbackAllowed) {
    transactionGroups.forEach((_, index) => {
      if (assigned[index] !== undefined) return;
      if (index < vouchers.length && !used.has(index)) {
        used.add(index);
        assigned[index] = index; // positional fallback
      }
    });
  }

  return {
    matched: assigned.map((voucherIndex) => (voucherIndex === undefined ? undefined : vouchers[voucherIndex])),
    matchedIndexes: assigned,
    usedIndexes: used,
  };
}

// Composite postings (2026-09-10). One-to-one matching cannot see two
// correct ways of recording the same thing: a transaction posted as TWO
// vouchers (Yeshas booked every April purchase without TDS and deducted the
// TDS in a separate journal: the purchase scored TDS_MISSING and the
// journals were invisible), or two transactions posted as ONE voucher
// (Praveen's software JV: Dr Software Subscription 3,000, Dr Prepaid
// Software 15,000, Cr Bank 18,000 is exactly the 18,000 payment plus the
// 15,000 prepaid transfer, and scored one wrong voucher plus one missing).
// After the one-to-one pass and its diffs, every transaction still carrying
// an error is tried again: as a SPLIT (its matched voucher plus one unused
// voucher, or two unused vouchers when nothing matched), then as a COMBINED
// posting (paired with another erroneous transaction against one voucher).
// A candidate is accepted only when the NET ledger effect is identical,
// account by account, and the rescored diffs carry fewer errors. A split
// is scored as the merged voucher; a combined voucher scores every
// structural field of both transactions correct and still judges GST, TDS
// and the bill reference on the voucher as posted.
// Bounds keep the pair search cheap on a 100-voucher pack: every erroneous
// transaction is still tried (Yeshas's April had well over a dozen); the
// pool of unused vouchers is what is capped.
const MAX_COMPOSITE_ERRONEOUS = 60;
const MAX_COMPOSITE_UNUSED = 20;
const COMPOSITE_TOLERANCE = 1;

function signedAmount(entry: LedgerEntry): number {
  return entry.drOrCr === 'Dr' ? entry.amount : -entry.amount;
}

function errorCount(diffs: VoucherDiff[]): number {
  return diffs.filter((diff) => !diff.is_correct).length;
}

function ledgerEffectMatches(entries: LedgerEntry[], legs: AnswerKeyEntry[], options: ScoringOptions = {}): boolean {
  const expected = new Map<string, { leg: AnswerKeyEntry; net: number }>();
  for (const leg of legs) {
    const key = normalizeAccountName(leg.correct_account);
    const current = expected.get(key) ?? { leg, net: 0 };
    current.net += leg.dr_cr === 'Dr' ? leg.amount : -leg.amount;
    expected.set(key, current);
  }
  // Exact names claim their entries first, the lenient match only serves
  // accounts left with nothing: the typo tolerance would otherwise let the
  // "Input CGST" leg absorb the posted "Input SGST" line as well (one edit
  // apart) and the effect could never balance.
  const remaining = [...entries];
  const actualByAccount = new Map<string, number>();
  for (const key of expected.keys()) {
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (normalizeAccountName(remaining[i].ledgerName) === key) {
        actualByAccount.set(key, (actualByAccount.get(key) ?? 0) + signedAmount(remaining[i]));
        remaining.splice(i, 1);
      }
    }
  }
  for (const [key, { leg }] of expected) {
    if (actualByAccount.has(key)) continue;
    for (let i = remaining.length - 1; i >= 0; i--) {
      if (legMatchesEntry(remaining[i], leg, options)) {
        actualByAccount.set(key, (actualByAccount.get(key) ?? 0) + signedAmount(remaining[i]));
        remaining.splice(i, 1);
      }
    }
  }
  for (const [key, { net }] of expected) {
    if (Math.abs((actualByAccount.get(key) ?? 0) - net) > COMPOSITE_TOLERANCE) {
      return false;
    }
  }
  // Leftover GST/TDS lines are tolerated: the authored pack key carries
  // tax as metadata on the party leg, not as legs, so a correct posting
  // always has tax lines the key never lists. Their correctness is judged
  // by diffGst/diffTds on the merged voucher, never here.
  const leftover = new Map<string, number>();
  for (const entry of remaining) {
    if (isTaxLedgerName(entry.ledgerName)) continue;
    const key = normalizeAccountName(entry.ledgerName);
    leftover.set(key, (leftover.get(key) ?? 0) + signedAmount(entry));
  }
  return [...leftover.values()].every((value) => Math.abs(value) <= COMPOSITE_TOLERANCE);
}

// The merged voucher a split posting amounts to: one entry per ledger with
// the net side and amount, bill allocations carried over, the type taken
// from whichever part carries the expected voucher type.
function mergeVouchers(parts: Voucher[], expectedType: string): Voucher {
  const primary = parts.find((part) => sameVoucherType(part.voucherType, expectedType)) ?? parts[0];
  const byLedger = new Map<string, { name: string; signed: number; allocations: LedgerEntry['billAllocations'] }>();
  for (const part of parts) {
    for (const entry of part.ledgerEntries) {
      const key = normalizeAccountName(entry.ledgerName);
      const current = byLedger.get(key) ?? { name: entry.ledgerName, signed: 0, allocations: [] };
      current.signed += signedAmount(entry);
      current.allocations = [...current.allocations, ...entry.billAllocations];
      byLedger.set(key, current);
    }
  }
  const ledgerEntries: LedgerEntry[] = [...byLedger.values()]
    .filter((ledger) => Math.abs(ledger.signed) >= 0.005)
    .map((ledger) => ({
      ledgerName: ledger.name,
      amount: round2(Math.abs(ledger.signed)),
      drOrCr: ledger.signed > 0 ? 'Dr' : 'Cr',
      billAllocations: ledger.allocations,
    }));
  return {
    voucherType: primary.voucherType,
    date: primary.date,
    narration: parts.map((part) => part.narration).filter((text) => text.trim().length > 0).join(' | '),
    ledgerEntries,
  };
}

// The voucher-level expectation of a transaction: GST/TDS/bill reference
// read from whichever leg states them (see diffVoucherAgainstAnswerKey).
function voucherLevelExpectation(expectedLegs: AnswerKeyEntry[]): AnswerKeyEntry {
  const gstLeg = expectedLegs.find((leg) => leg.gst_head !== null) ?? expectedLegs[0];
  const tdsLeg = expectedLegs.find((leg) => leg.tds_section !== null) ?? expectedLegs[0];
  const referenceLeg = expectedLegs.find((leg) => leg.bill_reference !== null) ?? expectedLegs[0];
  return {
    ...expectedLegs[0],
    gst_head: gstLeg.gst_head,
    gst_rate: gstLeg.gst_rate,
    tds_section: tdsLeg.tds_section,
    tds_rate: tdsLeg.tds_rate,
    tds_base: tdsLeg.tds_base,
    bill_reference: referenceLeg.bill_reference,
  };
}

function diffsForCombinedVoucher(
  voucher: Voucher,
  expectedLegs: AnswerKeyEntry[],
  allLegs: AnswerKeyEntry[],
  options: ScoringOptions = {},
): VoucherDiff[] {
  const sequence = expectedLegs[0].sequence;
  const diffs: VoucherDiff[] = [];
  for (let leg = 0; leg < consolidateExpectedLegs(expectedLegs).length; leg++) {
    for (const field of ['account', 'dr_cr', 'amount'] as const) {
      diffs.push({ voucherRef: sequence, field, expected_masked: true, is_correct: true, error_code: null, leg });
    }
  }
  diffs.push({ voucherRef: sequence, field: 'voucher_type', expected_masked: true, is_correct: true, error_code: null });
  const expected = voucherLevelExpectation(expectedLegs);
  diffs.push(diffGst(voucher, expected, allLegs, sequence, options));
  diffs.push(diffTds(voucher, expected, allLegs, sequence, options));
  diffs.push(diffBillReference(voucher, expectedLegs, sequence, options));
  const bankReferenceDiff = diffBankReference(voucher, expectedLegs, sequence);
  if (bankReferenceDiff) {
    diffs.push(bankReferenceDiff);
  }
  return diffs;
}

type CompositeState = {
  matchedIndexes: (number | undefined)[];
  matched: (Voucher | undefined)[];
  used: Set<number>;
  diffs: VoucherDiff[][];
  composites: CompositeMatch[];
};

function resolveComposites(
  vouchers: Voucher[],
  transactionGroups: AnswerKeyEntry[][],
  state: CompositeState,
  options: ScoringOptions = {},
): void {
  const erroneous = () => transactionGroups.map((_, index) => index).filter((index) => errorCount(state.diffs[index]) > 0);
  const unused = () => vouchers.map((_, index) => index).filter((index) => !state.used.has(index));
  if (erroneous().length === 0 || erroneous().length > MAX_COMPOSITE_ERRONEOUS || unused().length > MAX_COMPOSITE_UNUSED) {
    return;
  }

  // Splits.
  for (const index of erroneous()) {
    const legs = transactionGroups[index];
    const matchedIndex = state.matchedIndexes[index];
    const parts: [number, number][] =
      matchedIndex !== undefined
        ? unused().map((j) => [matchedIndex, j] as [number, number])
        : unused().flatMap((a, i, all) => all.slice(i + 1).map((b) => [a, b] as [number, number]));
    for (const [a, b] of parts) {
      const pieces = [vouchers[a], vouchers[b]];
      if (!ledgerEffectMatches(pieces.flatMap((piece) => piece.ledgerEntries), legs, options)) continue;
      const merged = mergeVouchers(pieces, legs[0].voucher_type);
      const diffs = diffVoucherAgainstAnswerKey(merged, legs, options);
      if (errorCount(diffs) >= errorCount(state.diffs[index])) continue;
      state.matched[index] = merged;
      state.matchedIndexes[index] = a;
      state.used.add(a);
      state.used.add(b);
      state.diffs[index] = diffs;
      state.composites.push({ kind: 'split', sequences: [legs[0].sequence], positions: [a + 1, b + 1].sort((x, y) => x - y) });
      break;
    }
  }

  // Combined.
  const candidates = erroneous();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const first = candidates[i];
      const second = candidates[j];
      if (errorCount(state.diffs[first]) === 0 || state.matchedIndexes[first] === state.matchedIndexes[second] && state.matchedIndexes[first] !== undefined) continue;
      if (errorCount(state.diffs[second]) === 0) continue;
      const allLegs = [...transactionGroups[first], ...transactionGroups[second]];
      const voucherCandidates = [state.matchedIndexes[first], state.matchedIndexes[second], ...unused()].filter(
        (index): index is number => index !== undefined,
      );
      for (const voucherIndex of voucherCandidates) {
        if (!ledgerEffectMatches(vouchers[voucherIndex].ledgerEntries, allLegs, options)) continue;
        const firstDiffs = diffsForCombinedVoucher(vouchers[voucherIndex], transactionGroups[first], allLegs, options);
        const secondDiffs = diffsForCombinedVoucher(vouchers[voucherIndex], transactionGroups[second], allLegs, options);
        if (errorCount(firstDiffs) + errorCount(secondDiffs) >= errorCount(state.diffs[first]) + errorCount(state.diffs[second])) continue;
        for (const index of [first, second]) {
          const previous = state.matchedIndexes[index];
          if (previous !== undefined && previous !== voucherIndex) state.used.delete(previous);
          state.matchedIndexes[index] = voucherIndex;
          state.matched[index] = vouchers[voucherIndex];
        }
        state.used.add(voucherIndex);
        state.diffs[first] = firstDiffs;
        state.diffs[second] = secondDiffs;
        state.composites.push({
          kind: 'combined',
          sequences: [transactionGroups[first][0].sequence, transactionGroups[second][0].sequence],
          positions: [voucherIndex + 1],
        });
        break;
      }
    }
  }
}

// Every voucher no transaction claimed, described for the feedback
// (2026-09-10): blank (no ledger line, or nothing but zeros), a duplicate of
// another voucher in the export, the exact reversal of another voucher, or
// simply extra.
const MAX_LISTED_LEDGERS = 4;

function legsSignature(voucher: Voucher, flipped = false): string {
  return voucher.ledgerEntries
    .map((entry) => {
      const side = flipped ? (entry.drOrCr === 'Dr' ? 'Cr' : 'Dr') : entry.drOrCr;
      return `${normalizeAccountName(entry.ledgerName)}:${side}:${round2(entry.amount)}`;
    })
    .sort()
    .join(',');
}

export function describeUnmatchedVouchers(vouchers: Voucher[], usedIndexes: Set<number>): UnmatchedVoucher[] {
  const signatures = vouchers.map((voucher) => `${voucher.voucherType.trim().toLowerCase()}|${legsSignature(voucher)}`);
  const flippedSignatures = vouchers.map((voucher) => legsSignature(voucher, true));
  const plainSignatures = vouchers.map((voucher) => legsSignature(voucher));
  const unmatched: UnmatchedVoucher[] = [];
  vouchers.forEach((voucher, index) => {
    if (usedIndexes.has(index)) return;
    const blank = voucher.ledgerEntries.length === 0 || voucher.ledgerEntries.every((entry) => Math.abs(entry.amount) < 0.005);
    let kind: UnmatchedVoucher['kind'] = 'extra';
    if (blank) {
      kind = 'blank';
    } else if (signatures.some((signature, other) => other !== index && signature === signatures[index])) {
      kind = 'duplicate';
    } else if (plainSignatures.some((signature, other) => other !== index && signature === flippedSignatures[index])) {
      kind = 'reversal';
    }
    unmatched.push({
      position: index + 1,
      date: voucher.date,
      voucher_type: voucher.voucherType,
      ledgers: [...new Set(voucher.ledgerEntries.map((entry) => entry.ledgerName))].slice(0, MAX_LISTED_LEDGERS),
      amount: voucher.ledgerEntries.reduce((max, entry) => Math.max(max, entry.amount), 0),
      kind,
    });
  });
  return unmatched;
}

// Groups answer key entries by sequence: a transaction's answer key is real
// double-entry, so each sequence number has one entry per ledger leg (Dr +
// Cr, or more for split postings), not one entry per voucher.
function groupAnswerKeyEntriesBySequence(entries: AnswerKeyEntry[]): AnswerKeyEntry[][] {
  const bySequence = new Map<number, AnswerKeyEntry[]>();
  for (const entry of entries) {
    const group = bySequence.get(entry.sequence) ?? [];
    group.push(entry);
    bySequence.set(entry.sequence, group);
  }
  return [...bySequence.entries()].sort(([a], [b]) => a - b).map(([, group]) => group);
}

// The key's own accounts, passed to every name comparison so typo tolerance
// never equates two distinct accounts of the batch (2026-09-17).
export function answerKeyMatchOptions(answerKey: AnswerKey): ScoringOptions {
  return {
    keyAccounts: keyAccountSet(answerKey.entries.map((entry) => entry.correct_account)),
    advanceReferences: advanceReferencesOf(answerKey),
  };
}

function matchAndDiff(vouchers: Voucher[], transactionGroups: AnswerKeyEntry[][], answerKey: AnswerKey): CompositeState {
  const options = answerKeyMatchOptions(answerKey);
  const matching = matchVouchersToTransactionsDetailed(vouchers, transactionGroups, options);
  const state: CompositeState = {
    matchedIndexes: [...matching.matchedIndexes],
    matched: [...matching.matched],
    used: new Set(matching.usedIndexes),
    diffs: transactionGroups.map((expectedLegs, index) => diffVoucherAgainstAnswerKey(matching.matched[index], expectedLegs, options)),
    composites: [],
  };
  resolveComposites(vouchers, transactionGroups, state, options);
  return state;
}

// The voucher each transaction was actually scored against, after split and
// combined postings are resolved (a split transaction's entry is the merged
// voucher). The adjudicator shows the judge exactly this (2026-09-17), not
// the one-to-one match that composite resolution may have replaced.
export function resolveScoredVouchers(dayBook: ParsedDayBook, answerKey: AnswerKey): (Voucher | undefined)[] {
  const transactionGroups = groupAnswerKeyEntriesBySequence(answerKey.entries);
  return matchAndDiff(dayBook.vouchers, transactionGroups, answerKey).matched;
}

// Pure function, no LLM call — see Unit 06 spec's boundary: correctness is
// computed deterministically here, never judged by an LLM. Diffs the parsed
// Day Book vouchers against the exercise's hidden answer key transaction-by-
// transaction (grouped by sequence, since each transaction's answer key is
// full double-entry), checks Trial Balance tie-out, and applies 2x weighting
// to GST/TDS error codes when computing weighted_score.
export function scoreSubmission(
  dayBook: ParsedDayBook,
  trialBalance: ParsedTrialBalance,
  answerKey: AnswerKey,
  // The learner's previous scored Trial Balance export, when one exists:
  // switches the tie-out to the movement comparison (see
  // evaluateTrialBalanceTieOut). Omitted/null on the first scored posting.
  options: { previousTrialBalance?: ParsedTrialBalance | null; firstMonthOfFinancialYear?: boolean } = {},
): ScoringResult {
  const transactionGroups = groupAnswerKeyEntriesBySequence(answerKey.entries);
  const state = matchAndDiff(dayBook.vouchers, transactionGroups, answerKey);
  const perVoucherDiffs = state.diffs.flat();

  const unmatchedVouchers = describeUnmatchedVouchers(dayBook.vouchers, state.used);
  const ledgerFindings = findLedgerFindings(dayBook.vouchers, answerKey);
  const tieOut = evaluateTrialBalanceTieOut(trialBalance, answerKey, options.previousTrialBalance ?? null, {
    firstMonthOfFinancialYear: options.firstMonthOfFinancialYear === true,
  });
  const weightedScore = computeWeightedScore(perVoucherDiffs, submissionPenaltyWeight(unmatchedVouchers, ledgerFindings));
  const overallResult = computeOverallResult(weightedScore, tieOut.tieOut);
  const conceptResults = computeConceptResults(perVoucherDiffs, transactionGroups, tieOut.tieOut);

  return {
    per_voucher_diffs: perVoucherDiffs,
    tb_tie_out: tieOut.tieOut,
    tb_tie_out_mismatches: tieOut.mismatches,
    unmatched_vouchers: unmatchedVouchers,
    ledger_findings: ledgerFindings,
    composite_matches: state.composites,
    weighted_score: weightedScore,
    overall_result: overallResult,
    concept_results: conceptResults,
  };
}

export function collectErrorCodes(scoringResult: ScoringResult): ScoringErrorCode[] {
  return scoringResult.per_voucher_diffs
    .map((diff) => diff.error_code)
    .filter((code): code is ScoringErrorCode => code !== null);
}

// Recomputes the derived fields of a ScoringResult from a (possibly
// adjudicated) diff list. Kept here so weighted-score thresholds, GST/TDS
// weighting, submission-level penalties and the concept rollup live in
// exactly one place — the adjudicator (adjudicate-findings.ts) flips
// dismissed findings to correct and calls this, never re-implementing any
// scoring math. `carried` are the submission-level facts the diffs do not
// encode (tie-out mismatches, extra vouchers, ledger findings, composites).
export type CarriedScoringFacts = Pick<
  ScoringResult,
  'tb_tie_out_mismatches' | 'unmatched_vouchers' | 'ledger_findings' | 'composite_matches' | 'books_reconciliation'
>;

export function rebuildScoringResult(
  diffs: VoucherDiff[],
  tbTieOut: boolean,
  answerKey: AnswerKey,
  carried: CarriedScoringFacts = {},
): ScoringResult {
  const transactionGroups = groupAnswerKeyEntriesBySequence(answerKey.entries);
  const unmatchedVouchers = carried.unmatched_vouchers ?? [];
  const ledgerFindings = carried.ledger_findings ?? [];
  const weightedScore = computeWeightedScore(diffs, submissionPenaltyWeight(unmatchedVouchers, ledgerFindings));
  const overallResult = computeOverallResult(weightedScore, tbTieOut);
  const conceptResults = computeConceptResults(diffs, transactionGroups, tbTieOut);

  return {
    per_voucher_diffs: diffs,
    tb_tie_out: tbTieOut,
    tb_tie_out_mismatches: carried.tb_tie_out_mismatches ?? [],
    unmatched_vouchers: unmatchedVouchers,
    ledger_findings: ledgerFindings,
    composite_matches: carried.composite_matches ?? [],
    books_reconciliation: carried.books_reconciliation,
    weighted_score: weightedScore,
    overall_result: overallResult,
    concept_results: conceptResults,
  };
}

export { groupAnswerKeyEntriesBySequence };
