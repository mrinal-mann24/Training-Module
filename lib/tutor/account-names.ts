// Ledger-name matching shared by the scorer and the ledger set-up checks.
// Moved out of score-submission.ts on 2026-09-10 so ledger-findings.ts can
// use the same rules without a circular import.

// Ledger-name comparison is normalized and containment-tolerant: learners
// write "Balaji Interiors (firm)", "HDFC Bank", "Credit Sales A/c" where the
// key says "Balaji Interiors", "HDFC Bank — 1234", "Sales". Normalization
// strips case/punctuation; containment (min 5 significant chars, to keep
// short names like "Cash" exact) accepts one name embedding the other. The
// answer key can also list explicit account_aliases per leg.
export function normalizeAccountName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Ledger families the house practice treats as the same account under
// different names (2026-09-10): month-end accruals sit in "Outstanding
// Expenses", "Accrued Expenses", "Expenses Payable" or Yeshas's "Accounts
// Payable" (same group, a naming choice, not a wrong entry). Both names must
// belong to the same family for the match to apply. Petty cash is NOT in a
// family with Cash: a second till is a separate ledger (2026-09-03 test).
const ACCOUNT_FAMILIES: RegExp[] = [
  /^(outstanding|accrued|accounts payable|expenses? payable)/i,
];

function sameAccountFamily(a: string, b: string): boolean {
  return ACCOUNT_FAMILIES.some((family) => family.test(a.trim()) && family.test(b.trim()));
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
export const GST_HEAD_TOKEN = /\b(cgst|sgst|igst)\b/i;

export function gstHeadOf(name: string): string | null {
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

export const RETURNS_TOKEN = /\breturns?\b/i;

export function accountNamesMatch(actual: string, expected: string): boolean {
  const a = normalizeAccountName(actual);
  const b = normalizeAccountName(expected);
  if (a === b) {
    return true;
  }
  if (sameAccountFamily(actual, expected)) {
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
  // Long names (14+ chars) allow 3 edits: "Office Maintanece" for "Office
  // Maintenance" is 3 edits and was scored ACCOUNT_WRONG on a correct
  // posting (Praveen's Level 3, 2026-09-03), and at that length a 3-edit
  // collision between two genuinely different ledgers does not occur in
  // the pack ("Karnataka Emporium" vs "Kolkata Emporium" is 4+).
  const maxEdits = shorter.length >= 14 ? 3 : shorter.length >= 8 ? 2 : shorter.length >= 6 ? 1 : 0;
  return maxEdits > 0 && editDistanceAtMost(a, b, maxEdits);
}

