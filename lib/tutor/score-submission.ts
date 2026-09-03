import type { ParsedDayBook, ParsedTrialBalance, Voucher, LedgerEntry } from '@/lib/schemas/voucher';
import type { AnswerKey, AnswerKeyEntry, ConceptTag } from '@/lib/schemas/exercise';
import type { ScoringErrorCode, ScoringResult, ScoredField, VoucherDiff, ConceptResult } from '@/lib/schemas/scoring';

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
// Ledger-name comparison is normalized and containment-tolerant: learners
// write "Balaji Interiors (firm)", "HDFC Bank", "Credit Sales A/c" where the
// key says "Balaji Interiors", "HDFC Bank — 1234", "Sales". Normalization
// strips case/punctuation; containment (min 5 significant chars, to keep
// short names like "Cash" exact) accepts one name embedding the other. The
// answer key can also list explicit account_aliases per leg.
function normalizeAccountName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Small edit-distance for typo tolerance ("Elecrticity Charges" — a real
// ledger name from the pilot submission). Capped early for performance.
function editDistanceAtMost(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) {
    return false;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > max) {
      return false;
    }
    previous = current;
  }
  return previous[b.length] <= max;
}

// GST ledgers are matched by tax HEAD, not by exact wording: the authored
// pack (and Tally's own defaults) name them plainly "IGST"/"CGST"/"SGST",
// generated keys say "Output IGST"/"Input CGST", and a 4-letter name can
// never clear the 5-char containment floor below — so a learner posting the
// right head to the right side was scored ACCOUNT_WRONG on every tax leg
// (Garima's Level 2, 2026-09-02). Input-vs-output side is still judged by
// diffGst, so this leniency only removes the naming penalty.
const GST_HEAD_TOKEN = /\b(cgst|sgst|igst)\b/i;

function gstHeadOf(name: string): string | null {
  const match = GST_HEAD_TOKEN.exec(name);
  return match ? match[1].toLowerCase() : null;
}

// Ledger names are the learner's own. The same expense head is "Rent" in
// the key, "Office Rent" in one learner's Tally and "Rent A/c" in another's;
// "Salaries" vs "SALARY AC"; "Electricity Charges" vs "Electricity Bill".
// Whole-name comparison flagged all three as ACCOUNT_WRONG on Praveen's
// Level 4 (2026-09-03) for postings that were right. Names match when,
// after dropping filler words (office, bill, charges, a/c, account,
// expenses…) and plural endings, their remaining words are IDENTICAL —
// equality, not overlap, so "Petty Cash" ≠ "Cash", "Sales Returns" ≠
// "Sales", "Warehouse Rent" ≠ "Office Rent".
const FILLER_TOKENS = new Set([
  'a', 'ac', 'acc', 'account', 'accounts', 'ledger', 'office', 'bill', 'bills',
  'charge', 'charges', 'expense', 'expenses', 'exp', 'payable', 'payables',
  'the', 'of', 'and', 'for', 'to', 'general', 'misc', 'sundry',
]);

function stemToken(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.length > 4 && token.endsWith('es') && !token.endsWith('ses')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function significantTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/a\/c/g, ' ac ')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !FILLER_TOKENS.has(token))
    .map(stemToken)
    .sort();
}

function significantTokensMatch(actual: string, expected: string): boolean {
  const a = significantTokens(actual);
  const b = significantTokens(expected);
  return a.length > 0 && a.length === b.length && a.every((token, index) => token === b[index]);
}

const RETURNS_TOKEN = /\breturns?\b/i;

function accountNamesMatch(actual: string, expected: string): boolean {
  const a = normalizeAccountName(actual);
  const b = normalizeAccountName(expected);
  if (a === b) {
    return true;
  }
  const actualHead = gstHeadOf(actual);
  if (actualHead !== null && actualHead === gstHeadOf(expected)) {
    return true;
  }
  if (significantTokensMatch(actual, expected)) {
    return true;
  }
  // "Sales Returns" embeds "Sales" and "Purchase Returns" embeds
  // "Purchases": containment/typo tolerance below must never equate a
  // returns ledger with its base ledger (a credit note posted to Sales is
  // exactly the error the key is trying to catch). Same rule the TB tie-out
  // applies via exact-first matching.
  if (RETURNS_TOKEN.test(actual) !== RETURNS_TOKEN.test(expected)) {
    return false;
  }
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 5 && longer.includes(shorter)) {
    return true;
  }
  // Typo tolerance scaled to name length — names of 8+ significant chars
  // allow 2 edits (a transposed pair costs 2 in plain Levenshtein and is the
  // most common real typo — "Purchsaes"), medium names 1, short names none
  // (too collision-prone).
  const maxEdits = shorter.length >= 8 ? 2 : shorter.length >= 6 ? 1 : 0;
  return maxEdits > 0 && editDistanceAtMost(a, b, maxEdits);
}

function legMatchesEntry(entry: LedgerEntry, leg: AnswerKeyEntry): boolean {
  if (accountNamesMatch(entry.ledgerName, leg.correct_account)) {
    return true;
  }
  return (leg.account_aliases ?? []).some((alias) => accountNamesMatch(entry.ledgerName, alias));
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
  const type = voucherType.trim().toLowerCase();
  if (type === 'sales' || type === 'credit note') {
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

function collectBillReferences(entries: LedgerEntry[]): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    for (const allocation of entry.billAllocations) {
      if (allocation.name.trim().length > 0) {
        names.push(allocation.name);
      }
    }
  }
  return names;
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

function consolidateExpectedLegs(legs: AnswerKeyEntry[]): AnswerKeyEntry[] {
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

function diffVoucherAgainstAnswerKey(voucher: Voucher | undefined, expectedLegs: AnswerKeyEntry[]): VoucherDiff[] {
  const diffs: VoucherDiff[] = [];
  const sequence = expectedLegs[0].sequence;

  if (!voucher) {
    diffs.push({
      voucherRef: sequence,
      field: 'account',
      expected_masked: true,
      is_correct: false,
      error_code: 'VOUCHER_MISSING',
    });
    return diffs;
  }

  const unmatchedEntries = consolidateLedgerEntries(voucher.ledgerEntries);

  for (const expectedLeg of consolidateExpectedLegs(expectedLegs)) {
    const matchIndex = unmatchedEntries.findIndex((entry) => legMatchesEntry(entry, expectedLeg));
    const matchingEntry = matchIndex === -1 ? undefined : unmatchedEntries[matchIndex];
    if (matchIndex !== -1) {
      unmatchedEntries.splice(matchIndex, 1);
    }

    diffs.push({
      voucherRef: sequence,
      field: 'account',
      expected_masked: true,
      is_correct: matchingEntry !== undefined,
      error_code: matchingEntry === undefined ? 'ACCOUNT_WRONG' : null,
    });

    const drCrCorrect = matchingEntry !== undefined && matchingEntry.drOrCr === expectedLeg.dr_cr;
    diffs.push({
      voucherRef: sequence,
      field: 'dr_cr',
      expected_masked: true,
      is_correct: drCrCorrect,
      error_code: matchingEntry === undefined ? null : drCrCorrect ? null : 'DR_CR_REVERSED',
    });

    // GST/TDS-named legs (the set-off JV, a TDS deposit) don't get amount-
    // checked: their correct figures depend on every upstream voucher, so a
    // single upstream slip would cascade into a wall of AMOUNT_WRONGs here.
    // Presence and direction still score; the aggregate effect is covered by
    // the per-voucher gst/tds checks and the (tax-exempt) TB tie-out.
    const taxLeg = /gst|tds/i.test(expectedLeg.correct_account);
    const amountCorrect =
      matchingEntry !== undefined && (taxLeg || amountsMatch(matchingEntry.amount, expectedLeg.amount));
    diffs.push({
      voucherRef: sequence,
      field: 'amount',
      expected_masked: true,
      is_correct: amountCorrect,
      vacuously_correct: taxLeg && matchingEntry !== undefined ? true : undefined,
      error_code: matchingEntry === undefined ? null : amountCorrect ? null : 'AMOUNT_WRONG',
    });
  }

  // Voucher-level fields: voucher_type/bill_reference/narration are shared by
  // every leg, so the first leg represents the transaction — EXCEPT the tax
  // expectation. Generated keys carry gst_head/tds_section only on the tax
  // leg itself (the party leg says null), so reading legs[0] declared "no
  // GST expected" and flagged every correct GST posting as GST_UNEXPECTED
  // (Garima's Level 2: 6 of 6 taxed transactions, 2026-09-02). The
  // transaction's expectation is whichever leg states one.
  const gstLeg = expectedLegs.find((leg) => leg.gst_head !== null) ?? expectedLegs[0];
  const tdsLeg = expectedLegs.find((leg) => leg.tds_section !== null) ?? expectedLegs[0];
  const expected = { ...expectedLegs[0], gst_head: gstLeg.gst_head, gst_rate: gstLeg.gst_rate, tds_section: tdsLeg.tds_section, tds_rate: tdsLeg.tds_rate, tds_base: tdsLeg.tds_base };

  const voucherTypeCorrect = voucher.voucherType.trim().toLowerCase() === expected.voucher_type.trim().toLowerCase();
  diffs.push({
    voucherRef: sequence,
    field: 'voucher_type',
    expected_masked: true,
    is_correct: voucherTypeCorrect,
    error_code: voucherTypeCorrect ? null : 'VOUCHER_TYPE_WRONG',
  });

  diffs.push(diffGst(voucher, expected, expectedLegs, sequence));
  diffs.push(diffTds(voucher, expected, expectedLegs, sequence));
  diffs.push(diffBillReference(voucher, expected, sequence));
  diffs.push(diffNarration(voucher, expected, sequence));

  return diffs;
}

// Inference for the "unexpected tax" checks must ignore ledger entries that
// ARE the transaction's own expected legs: a TDS-deposit payment's main
// account is a TDS Payable ledger, and the GST set-off JV's legs are all
// GST ledgers — flagging those as "unexpected GST/TDS" penalized correct
// postings (pilot calibration, 2026-08-20).
function entriesBeyondExpectedLegs(voucher: Voucher, expectedLegs: AnswerKeyEntry[]): LedgerEntry[] {
  return voucher.ledgerEntries.filter((entry) => !expectedLegs.some((leg) => legMatchesEntry(entry, leg)));
}

function diffGst(
  voucher: Voucher,
  expected: AnswerKeyEntry,
  expectedLegs: AnswerKeyEntry[],
  voucherRef: number,
): VoucherDiff {
  const actualGst = collectGstFromLedgerEntries(
    expected.gst_head === null ? entriesBeyondExpectedLegs(voucher, expectedLegs) : voucher.ledgerEntries,
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
  const headCorrect = expectedIntraState
    ? actualGst.heads.has('CGST') && actualGst.heads.has('SGST') && !actualGst.heads.has('IGST')
    : actualGst.heads.has('IGST') && !actualGst.heads.has('CGST') && !actualGst.heads.has('SGST');

  // Side check (Input vs Output) only when the learner's ledger name states
  // a side AND the voucher type implies one — silent otherwise, so plain
  // "IGST Payable"-style naming isn't penalized. Any stated side that
  // contradicts the required one (an Output GST leg on a purchase, an Input
  // GST leg on a sale) fails the check.
  const requiredSide = expectedGstSide(expected.voucher_type);
  const sideWrong = requiredSide !== null && [...actualGst.sides].some((side) => side !== requiredSide);

  const gstCorrect = headCorrect && !sideWrong;
  const splitMissed =
    expectedIntraState &&
    !actualGst.heads.has('IGST') &&
    actualGst.heads.has('CGST') !== actualGst.heads.has('SGST');
  return {
    voucherRef,
    field: 'gst',
    expected_masked: true,
    is_correct: gstCorrect,
    error_code: gstCorrect ? null : splitMissed && !sideWrong ? 'GST_MISSING' : 'GST_HEAD_WRONG',
  };
}

function diffTds(
  voucher: Voucher,
  expected: AnswerKeyEntry,
  expectedLegs: AnswerKeyEntry[],
  voucherRef: number,
): VoucherDiff {
  const actualTds = inferTdsFromLedgerEntries(
    expected.tds_section === null ? entriesBeyondExpectedLegs(voucher, expectedLegs) : voucher.ledgerEntries,
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

// A voucher can carry several allocations (a payment split across bills, an
// advance applied plus a New Ref balance) and the key's bill_reference may
// name several refs — correct when ANY submitted allocation matches ANY
// expected ref (normalized containment, so "INV-025" matches "INV-025 dt
// 04-May"). First-allocation-only exact comparison under-credited real
// submissions (pilot calibration, 2026-08-20).
function diffBillReference(voucher: Voucher, expected: AnswerKeyEntry, voucherRef: number): VoucherDiff {
  if (expected.bill_reference === null) {
    return {
      voucherRef,
      field: 'bill_reference',
      expected_masked: true,
      is_correct: true,
      error_code: null,
    };
  }

  const actualReferences = collectBillReferences(voucher.ledgerEntries);
  if (actualReferences.length === 0) {
    return {
      voucherRef,
      field: 'bill_reference',
      expected_masked: true,
      is_correct: false,
      error_code: 'BILL_REFERENCE_MISSING',
    };
  }

  // Generated keys annotate references — "BR-205 (New Ref)", "Against DT-114
  // (Partial)" — and comparing the whole string meant a learner's correct
  // "BR-205" never matched (Garima's Level 2: 7 false BILL_REFERENCE_WRONGs,
  // 2026-09-02). Only the reference itself is compared: parentheticals and
  // the "Against" prefix are annotations, not part of the ref.
  // Parentheticals are stripped BEFORE splitting: an annotation such as
  // "(part payment, ₹30,000 balance outstanding)" carries its own comma.
  const expectedRefs = expected.bill_reference
    .replace(/\([^)]*\)/g, '')
    .split(/[,;]/)
    .map((ref) => ref.replace(/^\s*against\s+/i, ''))
    .map((ref) => normalizeAccountName(ref))
    .filter((ref) => ref.length > 0);
  const referenceCorrect = actualReferences.some((actual) => {
    const normalizedActual = normalizeAccountName(actual);
    return expectedRefs.some(
      (ref) => normalizedActual === ref || normalizedActual.includes(ref) || ref.includes(normalizedActual),
    );
  });
  return {
    voucherRef,
    field: 'bill_reference',
    expected_masked: true,
    is_correct: referenceCorrect,
    error_code: referenceCorrect ? null : 'BILL_REFERENCE_WRONG',
  };
}

// Phase 3 (spec 15): voucher-type-aware narration standard, deterministic.
// Payments/Receipts require a reference-like token AND a party-name match
// against the voucher's own ledger names (the pilot deliverable line: "bank
// reference verbatim PLUS party name on every payment and receipt");
// Journals require a non-trivial "why"; Sales/Purchases/Contra stay
// presence-only. CONTENT-matching against the key's canonical wording is
// still deliberately not attempted - exact-text comparison would punish
// every legitimate phrasing. A present-but-substandard narration is
// NARRATION_WEAK (Appendix A: E09 narration weak); the LLM adjudicator can
// dismiss over-strict flags on phrasings this deterministic check misses.

// A bank-reference-like token: any 3+ digit run (UTR/cheque/challan
// numbers) or a recognizable transfer-mode keyword.
const NARRATION_REFERENCE_PATTERN = /\d{3,}|\b(?:neft|imps|rtgs|upi|utr|chq|cheque)\b/i;

// Words too generic to prove the narration names the counterparty.
const PARTY_WORD_STOPLIST = new Set([
  'bank', 'cash', 'account', 'limited', 'private', 'india', 'charges',
  'services', 'service', 'company', 'enterprises', 'traders', 'payable',
  'receivable', 'expenses', 'expense',
]);

// Narration tokens too generic to count as a party mention when prefix-
// matching (pilot calibration, 2026-08-26: without this, "paid" would match
// a party named "Paints" on a shared 3-char prefix).
const NARRATION_GENERIC_TOKENS = new Set([
  'being', 'paid', 'payment', 'payments', 'received', 'receipt', 'against',
  'bank', 'cash', 'bill', 'bills', 'charges', 'made', 'neft', 'imps',
  'rtgs', 'upi', 'utr', 'chq', 'cheque', 'invoice', 'amount', 'towards',
  'from', 'month', 'purchase', 'sale', 'settlement', 'full', 'partial',
]);

function consonantSkeleton(word: string): string {
  return word.replace(/[aeiou]/g, '');
}

// Does this narration token plausibly reference this party word? Real bank
// narrations compress party names into reference strings ("KAREMP" for
// Karnataka Emporium, "BNGCLEAN" for Bangalore Cleaning, "KHANDICRAFT" for
// Kerala Handicrafts) — the pilot reviewer accepted all of these, so exact
// word containment alone flagged 23 false NARRATION_WEAKs on the real pilot
// submission. Accepted forms: a shared 3+ char prefix, the word's leading 4
// chars embedded in the token, or a shared 3+ char consonant-skeleton
// prefix (BNG ~ BaNGalore).
function tokenReferencesPartyWord(token: string, word: string): boolean {
  if (token.slice(0, 3) === word.slice(0, 3)) {
    return true;
  }
  if (token.includes(word.slice(0, 4))) {
    return true;
  }
  return consonantSkeleton(token).slice(0, 3) === consonantSkeleton(word).slice(0, 3);
}

// Does the narration mention any party posted on this voucher? Checks each
// non-bank/cash/tax ledger name word-by-word ("Parekh Integrated Services
// Pvt Ltd" matches a narration that says just "Parekh", and abbreviation
// forms per tokenReferencesPartyWord). A voucher with no party-like ledger
// at all (e.g. a bank-charge payment: Bank Charges + Bank) has nothing to
// name, so the requirement is vacuously met.
function narrationNamesAParty(narration: string, voucher: Voucher): boolean {
  const haystack = narration.toLowerCase();
  const tokens = haystack
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !/^\d+$/.test(token) && !NARRATION_GENERIC_TOKENS.has(token));
  let hasCandidate = false;
  for (const entry of voucher.ledgerEntries) {
    if (/bank|cash|gst|tds/i.test(entry.ledgerName)) {
      continue;
    }
    const words = entry.ledgerName
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4 && !PARTY_WORD_STOPLIST.has(word));
    if (words.length === 0) {
      continue;
    }
    hasCandidate = true;
    if (words.some((word) => haystack.includes(word))) {
      return true;
    }
    if (words.some((word) => tokens.some((token) => tokenReferencesPartyWord(token, word)))) {
      return true;
    }
  }
  return !hasCandidate;
}

const MIN_JOURNAL_NARRATION_LENGTH = 15;
const MIN_JOURNAL_NARRATION_WORDS = 3;

function narrationMeetsVoucherTypeStandard(voucher: Voucher, narration: string): boolean {
  const voucherType = voucher.voucherType.toLowerCase();
  if (voucherType.includes('payment') || voucherType.includes('receipt')) {
    // A cash payment/receipt has no bank reference to quote — the reference
    // half of the standard only applies when a bank ledger is on the voucher.
    const involvesBank = voucher.ledgerEntries.some((entry) => /bank/i.test(entry.ledgerName));
    const referenceOk = !involvesBank || NARRATION_REFERENCE_PATTERN.test(narration);
    return referenceOk && narrationNamesAParty(narration, voucher);
  }
  if (voucherType.includes('journal')) {
    return (
      narration.length >= MIN_JOURNAL_NARRATION_LENGTH &&
      narration.split(/\s+/).length >= MIN_JOURNAL_NARRATION_WORDS
    );
  }
  return true;
}

function diffNarration(voucher: Voucher, expected: AnswerKeyEntry, voucherRef: number): VoucherDiff {
  if (expected.narration === null) {
    return {
      voucherRef,
      field: 'narration',
      expected_masked: true,
      is_correct: true,
      error_code: null,
    };
  }

  const narration = voucher.narration.trim();
  if (narration.length === 0) {
    return {
      voucherRef,
      field: 'narration',
      expected_masked: true,
      is_correct: false,
      error_code: 'NARRATION_MISSING',
    };
  }

  const meetsStandard = narrationMeetsVoucherTypeStandard(voucher, narration);
  return {
    voucherRef,
    field: 'narration',
    expected_masked: true,
    is_correct: meetsStandard,
    error_code: meetsStandard ? null : 'NARRATION_WEAK',
  };
}

function amountsMatch(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) < 0.005;
}

function computeWeightedScore(diffs: VoucherDiff[]): number {
  let totalWeight = 0;
  let earnedWeight = 0;

  for (const diff of diffs) {
    const weight = FIELD_WEIGHT[diff.field];
    totalWeight += weight;
    if (diff.is_correct) {
      earnedWeight += weight;
    }
  }

  return totalWeight === 0 ? 0 : earnedWeight / totalWeight;
}

function computeOverallResult(weightedScore: number, tbTieOut: boolean): 'pass' | 'partial' | 'fail' {
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

// Would the correct posting (per the answer key) produce the same TB closing
// balances the learner's TB export shows? Groups the answer key's expected
// entries by account, nets Dr/Cr into a signed closing balance per account,
// and compares against the parsed Trial Balance's closing balances.
// GST- and TDS-named accounts are exempt from the comparison: the answer
// key's leg model carries GST/TDS as voucher-level METADATA (scored per
// voucher by diffGst/diffTds), not as ledger legs, so the key cannot
// reproduce the learner's real Output/Input GST or TDS Payable ledger
// balances - comparing them would fail every correct submission. Opening
// balances (authored packs) seed each account so closing = opening +
// movements; a fully-settled account legitimately absent from the learner's
// TB only fails when its expected closing is non-zero.
const TIE_OUT_EXEMPT_PATTERN = /gst|tds/i;

function checkTrialBalanceTieOut(trialBalance: ParsedTrialBalance, answerKey: AnswerKey): boolean {
  const expectedClosingBalances = new Map<string, number>();

  for (const opening of answerKey.opening_balances ?? []) {
    const key = opening.account.trim().toLowerCase();
    const signedAmount = opening.dr_cr === 'Dr' ? opening.amount : -opening.amount;
    expectedClosingBalances.set(key, (expectedClosingBalances.get(key) ?? 0) + signedAmount);
  }

  const aliasesByAccount = new Map<string, string[]>();
  for (const entry of answerKey.entries) {
    const key = entry.correct_account.trim().toLowerCase();
    const signedAmount = entry.dr_cr === 'Dr' ? entry.amount : -entry.amount;
    expectedClosingBalances.set(key, (expectedClosingBalances.get(key) ?? 0) + signedAmount);
    if (entry.account_aliases?.length) {
      aliasesByAccount.set(key, entry.account_aliases);
    }
  }

  // TB rows that are an EXACT name match for some expected account belong to
  // that account and nothing else. Without this, containment matching let a
  // short name swallow a longer, genuinely different one: "Sales" matched
  // both "Sales" and "Sales Returns", so BOTH accounts were compared against
  // the sum of the two and tie-out could never succeed (found 2026-09-02
  // while verifying the carried-forward openings fix — it had been quietly
  // failing every submission that used a returns ledger).
  const exactlyClaimed = new Set<string>();
  for (const account of expectedClosingBalances.keys()) {
    const names = [account, ...(aliasesByAccount.get(account) ?? [])].map(normalizeAccountName);
    for (const ledger of trialBalance.ledgers) {
      if (names.includes(normalizeAccountName(ledger.ledgerName))) {
        exactlyClaimed.add(ledger.ledgerName);
      }
    }
  }

  for (const [account, expectedBalance] of expectedClosingBalances) {
    if (TIE_OUT_EXEMPT_PATTERN.test(account)) {
      continue;
    }
    // Aggregate every TB row matching this account: a learner may split one
    // logical account across ledgers (e.g. "Credit Sales A/c" + "Cash Sales
    // A/c" where the key says "Sales") — their SUM is what must tie out.
    // Exact matches win outright; the fuzzy split-account fallback only
    // considers rows no other expected account has claimed exactly.
    const acceptableNames = [account, ...(aliasesByAccount.get(account) ?? [])];
    const normalizedNames = acceptableNames.map(normalizeAccountName);
    const exactRows = trialBalance.ledgers.filter((ledger) =>
      normalizedNames.includes(normalizeAccountName(ledger.ledgerName)),
    );
    const matchingRows =
      exactRows.length > 0
        ? exactRows
        : trialBalance.ledgers.filter(
            (ledger) =>
              !exactlyClaimed.has(ledger.ledgerName) &&
              acceptableNames.some((name) => accountNamesMatch(ledger.ledgerName, name)),
          );
    if (matchingRows.length === 0) {
      if (amountsMatch(0, expectedBalance)) {
        continue;
      }
      return false;
    }
    const actualBalance = matchingRows.reduce(
      (sum, row) => sum + (row.closingDebit - row.closingCredit),
      0,
    );
    if (!amountsMatch(actualBalance, expectedBalance)) {
      return false;
    }
  }

  return true;
}

// Rolls per-voucher diffs up to a per-concept pass/fail (Unit 09). A
// transaction "passes" for a concept if every scored field diffed for that
// transaction (sequence) is correct — same all-fields-correct bar the
// diagnostic uses for a clean voucher. A concept tagged on more than one
// transaction in this exercise fails overall if any occurrence fails, since
// a single wrong application means the concept isn't reliably applied yet.
const CONCEPT_PASS_RATIO = 0.9;

function computeConceptResults(
  diffs: VoucherDiff[],
  transactionGroups: AnswerKeyEntry[][],
): ConceptResult[] {
  const transactionPassBySequence = new Map<number, boolean>();
  for (const group of transactionGroups) {
    const sequence = group[0].sequence;
    const sequenceDiffs = diffs.filter((diff) => diff.voucherRef === sequence);
    const allCorrect = sequenceDiffs.length > 0 && sequenceDiffs.every((diff) => diff.is_correct);
    transactionPassBySequence.set(sequence, allCorrect);
  }

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
    const passed = transactionPassBySequence.get(sequence) ?? false;
    const conceptTags = new Set(group.flatMap((entry) => entry.concept_tags));

    for (const tag of conceptTags) {
      const counts = conceptCounts.get(tag) ?? { passed: 0, total: 0 };
      counts.total += 1;
      if (passed) {
        counts.passed += 1;
      }
      conceptCounts.set(tag, counts);
    }
  }

  return [...conceptCounts.entries()].map(([concept_tag, counts]) => ({
    concept_tag,
    result: counts.passed / counts.total >= CONCEPT_PASS_RATIO ? 'pass' : 'fail',
  }));
}

// Pairs each expected transaction with the submitted voucher that best
// matches it, instead of assuming daybook position N is transaction N.
// Position-based matching breaks on realistic exports: a learner who posts
// two same-day vouchers in the other order would have every field of BOTH
// scored against the wrong key (added 2026-08-19 for the 98-voucher pack
// diagnostic, where positional drift would cascade through the whole month).
//
// Greedy by similarity: expected transactions are processed in sequence
// order; each takes the highest-scoring unused voucher (account-name matches
// are the strongest signal, then amount, then voucher type). Ties break on
// daybook position, which preserves the old positional behavior exactly when
// vouchers are indistinguishable.
//
// Generic ledger legs (Sales, Purchase, Cash, a bank, a GST/TDS head) prove
// nothing about WHICH transaction a voucher is — nearly every purchase
// voucher matches a "Purchases Dr" leg. Only a distinctive party/expense leg
// identifies a transaction, so generic matches score low and a pairing needs
// MIN_MATCH_SCORE of accumulated evidence (a distinctive account match, or
// amounts plus corroboration) to count at all. Without the bar, a
// transaction the learner never posted greedily stole whichever unused
// voucher shared a generic "Purchase" leg, and every field of that innocent
// voucher was then flagged against the wrong key — the live 2026-08-31 pilot
// evaluation told the learner to "re-check GST on AI-201" when the truth was
// that the AI-201 purchase was never entered.
//
// A transaction with no qualifying match falls back to its positional
// voucher only when the submission has at most as many vouchers as the key
// has transactions (a short drill, where position is meaningful); on a pack
// export with extra vouchers it reports VOUCHER_MISSING instead.
const GENERIC_LEDGER_PATTERN = /^(sales|purchases?|cash|bank|hdfc|output|input|c?gst|sgst|igst|tds|suspense|sales returns?|purchase returns?)\b/i;

const DISTINCTIVE_ACCOUNT_SCORE = 4;
const GENERIC_ACCOUNT_SCORE = 1;
const AMOUNT_SCORE = 1;
const VOUCHER_TYPE_SCORE = 1;
const MIN_MATCH_SCORE = 4;

export function matchVouchersToTransactions(
  vouchers: Voucher[],
  transactionGroups: AnswerKeyEntry[][],
): (Voucher | undefined)[] {
  const used = new Set<number>();

  function similarity(voucher: Voucher, expectedLegs: AnswerKeyEntry[]): number {
    let score = 0;
    for (const leg of expectedLegs) {
      if (voucher.ledgerEntries.some((entry) => legMatchesEntry(entry, leg))) {
        score += GENERIC_LEDGER_PATTERN.test(leg.correct_account)
          ? GENERIC_ACCOUNT_SCORE
          : DISTINCTIVE_ACCOUNT_SCORE;
      }
      if (voucher.ledgerEntries.some((entry) => amountsMatch(entry.amount, leg.amount))) {
        score += AMOUNT_SCORE;
      }
    }
    if (voucher.voucherType.trim().toLowerCase() === expectedLegs[0].voucher_type.trim().toLowerCase()) {
      score += VOUCHER_TYPE_SCORE;
    }
    return score;
  }

  const positionalFallbackAllowed = vouchers.length <= transactionGroups.length;

  return transactionGroups.map((expectedLegs, index) => {
    let bestIndex = -1;
    let bestScore = MIN_MATCH_SCORE - 1;
    for (let i = 0; i < vouchers.length; i++) {
      if (used.has(i)) {
        continue;
      }
      const score = similarity(vouchers[i], expectedLegs);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex === -1 && positionalFallbackAllowed && index < vouchers.length && !used.has(index)) {
      bestIndex = index; // positional fallback
    }
    if (bestIndex === -1) {
      return undefined;
    }
    used.add(bestIndex);
    return vouchers[bestIndex];
  });
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
): ScoringResult {
  const perVoucherDiffs: VoucherDiff[] = [];

  const transactionGroups = groupAnswerKeyEntriesBySequence(answerKey.entries);
  const matchedVouchers = matchVouchersToTransactions(dayBook.vouchers, transactionGroups);

  transactionGroups.forEach((expectedLegs, index) => {
    perVoucherDiffs.push(...diffVoucherAgainstAnswerKey(matchedVouchers[index], expectedLegs));
  });

  const tbTieOut = checkTrialBalanceTieOut(trialBalance, answerKey);
  const weightedScore = computeWeightedScore(perVoucherDiffs);
  const overallResult = computeOverallResult(weightedScore, tbTieOut);
  const conceptResults = computeConceptResults(perVoucherDiffs, transactionGroups);

  return {
    per_voucher_diffs: perVoucherDiffs,
    tb_tie_out: tbTieOut,
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
// weighting, and the concept rollup live in exactly one place — the
// adjudicator (adjudicate-findings.ts) flips dismissed findings to correct
// and calls this, never re-implementing any scoring math.
export function rebuildScoringResult(
  diffs: VoucherDiff[],
  tbTieOut: boolean,
  answerKey: AnswerKey,
): ScoringResult {
  const transactionGroups = groupAnswerKeyEntriesBySequence(answerKey.entries);
  const weightedScore = computeWeightedScore(diffs);
  const overallResult = computeOverallResult(weightedScore, tbTieOut);
  const conceptResults = computeConceptResults(diffs, transactionGroups);

  return {
    per_voucher_diffs: diffs,
    tb_tie_out: tbTieOut,
    weighted_score: weightedScore,
    overall_result: overallResult,
    concept_results: conceptResults,
  };
}

export { groupAnswerKeyEntriesBySequence };
