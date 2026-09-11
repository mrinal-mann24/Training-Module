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
  // "Advertising and Marketing" (Praveen's ledger) is "Advertisement &
  // Marketing" in the key: one stem for the family (2026-09-11).
  if (token.startsWith('advertis')) return 'advertis';
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

// Ledger classification shared by the books reconciliation and the Trial
// Balance tie-out (moved here from books-reconciliation.ts on 2026-09-11
// so the scorer can use it without an import cycle). Balance-sheet ledgers
// carry their balance across financial years; profit-and-loss ledgers are
// restarted by Tally at each new financial year.
export type LedgerKind = 'balance_sheet' | 'profit_and_loss' | 'tax' | 'unknown';

const LEDGER_TAX_PATTERN = /gst|tds/i;
const BALANCE_SHEET_PATTERN =
  /\b(cash|bank|hdfc|capital|equipment|machinery|furniture|vehicle|computer|asset|loan|deposit|prepaid|outstanding|accrued|payable|receivable|suspense|advance|provision|stock|investment|drawings|reserve)\b/i;
const PROFIT_AND_LOSS_PATTERN =
  /\b(sales|purchases?|returns?|charges?|expenses?|fees?|rent|salar(y|ies)|wages|income|interest|depreciation|bad debts?|subscription|maintenance|advertis\w*|marketing|freight|delivery|packing|electricity|repairs?|discount|round[- ]?off|penalt\w*|late fee|commission|insurance|printing|stationery|travel|conveyance|telephone|internet|audit|legal|professional|consult\w*|cleaning|housekeeping|software|courier|postage|bonus|misc\w*|written off)\b/i;

// "Bank Charges", "Bank Interest", "Cash Discount": expense and income
// ledgers that carry a balance-sheet word (Garima's April: Bank Charges
// was read as a bank ledger and never restarted at the year change).
const BANK_CASH_PROFIT_AND_LOSS = /\b(bank|cash)\s+(charges?|fees?|commission|interest|discount)\b/i;

export function classifyLedger(account: string, partyAccounts: Set<string>): LedgerKind {
  if (LEDGER_TAX_PATTERN.test(account)) return 'tax';
  if (partyAccounts.has(normalizeAccountName(account))) return 'balance_sheet';
  if (BANK_CASH_PROFIT_AND_LOSS.test(account)) return 'profit_and_loss';
  if (BALANCE_SHEET_PATTERN.test(account)) return 'balance_sheet';
  if (PROFIT_AND_LOSS_PATTERN.test(account)) return 'profit_and_loss';
  return 'unknown';
}

// The party accounts of an answer key: the ledgers that carry bill
// references ON THE PARTY SIDE of a voucher — the customer is debited on a
// sale or debit note and credited on a receipt or credit note, the supplier
// is credited on a purchase and debited on a payment. Generated keys stamp
// the bill reference on every leg of a voucher, so "any leg with a
// reference" (the rule until 2026-09-11) made Sales, Purchases, Rent and
// the expense ledgers parties, i.e. balance-sheet ledgers that never
// restart at a financial year (every intern's April: "Sales off by the
// whole of 2024-25"). Core profit-and-loss names are never parties.
const PARTY_SIDE: Record<string, 'Dr' | 'Cr'> = {
  sales: 'Dr',
  'debit note': 'Dr',
  payment: 'Dr',
  purchase: 'Cr',
  'credit note': 'Cr',
  receipt: 'Cr',
};
const CORE_PROFIT_AND_LOSS = /\b(sales|purchases?|returns?|rent|charges?|fees?|expenses?|income|interest|depreciation|salar(y|ies)|wages)\b/i;

export function partyAccountsOf(
  entries: readonly { correct_account: string; dr_cr: 'Dr' | 'Cr'; voucher_type: string; bill_reference: string | null }[],
): Set<string> {
  const parties = new Set<string>();
  for (const entry of entries) {
    if (entry.bill_reference === null || LEDGER_TAX_PATTERN.test(entry.correct_account)) continue;
    if (CORE_PROFIT_AND_LOSS.test(entry.correct_account)) continue;
    const side = PARTY_SIDE[entry.voucher_type.trim().toLowerCase()];
    if (side !== undefined && entry.dr_cr !== side) continue;
    parties.add(normalizeAccountName(entry.correct_account));
  }
  return parties;
}

// TDS ledgers carry the section in their name ("TDS Payable — u/s 194J").
// Two names citing different known sections are different accounts even
// when everything else matches, so a deduction booked under the wrong
// section (rulebook 12, E06) is not excused by the typo tolerance below
// ("...194J" vs "...194C" is one edit). Only recognised sections take part:
// a learner's "194Ci" (Praveen's typo for 194I) falls through to the
// ordinary rules.
const TDS_SECTION_TOKEN = /\b194\s*([a-z]{1,2})\b/i;
const KNOWN_TDS_SECTIONS = new Set(['a', 'c', 'h', 'i', 'j', 'q']);

export function tdsSectionOf(name: string): string | null {
  const match = TDS_SECTION_TOKEN.exec(name);
  if (!match) return null;
  const letter = match[1].toLowerCase();
  return KNOWN_TDS_SECTIONS.has(letter) ? `194${letter}` : null;
}

export function accountNamesMatch(actual: string, expected: string): boolean {
  const a = normalizeAccountName(actual);
  const b = normalizeAccountName(expected);
  if (a === b) {
    return true;
  }
  const actualSection = tdsSectionOf(actual);
  const expectedSection = tdsSectionOf(expected);
  if (actualSection !== null && expectedSection !== null && actualSection !== expectedSection) {
    return false;
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

