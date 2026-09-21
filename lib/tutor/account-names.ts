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

// The family words themselves; what is left after removing them (and the
// filler words) is what makes an accrual ledger specific.
const FAMILY_WORDS = new Set(['outstanding', 'accrued', 'payable', 'payables', 'account', 'accounts', 'expense', 'expenses', 'exp']);

// A family only equates a GENERIC accrual ledger with another member
// (2026-09-17): "Outstanding Salary" and "Outstanding Rent" both start with
// "outstanding" and were read as one account, though each is a specific
// accrual. One side must carry nothing beyond the family words.
function sameAccountFamily(a: string, b: string): boolean {
  if (!ACCOUNT_FAMILIES.some((family) => family.test(a.trim()) && family.test(b.trim()))) return false;
  const specific = (name: string) => rawTokens(name).filter((token) => !FAMILY_WORDS.has(token) && !FILLER_TOKENS.has(token));
  return specific(a).length === 0 || specific(b).length === 0;
}

function rawTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/a\/c/g, ' ac ')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

// Tax ledgers by word, never by substring (2026-09-17): "Kingston Traders"
// contains "gst" and was treated as a tax ledger (skipped from amount
// checks, excluded from the party set). CGST/SGST/IGST/UTGST/GST and TDS
// count only as words of their own ("GST@18%", "TDS194C" still count).
const TAX_WORD = /(?<![a-z])(?:[csi]|ut)?gst(?![a-z])|(?<![a-z])tds(?![a-z])/i;

// A GST- or TDS-worded EXPENSE is not a tax control ledger: "GST Late Fee
// and Interest" (rulebook 13) is an indirect expense with a balance to
// carry and tie out like any other (pre-launch review, 2026-09-22).
const TAX_WORDED_EXPENSE = /late fee|interest|penalt/i;

export function isTaxLedgerName(name: string): boolean {
  return TAX_WORD.test(name) && !TAX_WORDED_EXPENSE.test(name);
}

// Balance-sheet markers (2026-09-17). "payable" is a filler word for the
// token comparison, so "Salary Payable" read as "Salaries" and "Rent
// Payable" as "Rent": an accrual posted to the expense head. A name carrying
// one of these words is never the same account as a name without one.
const BALANCE_SHEET_MARKERS = new Set([
  'payable', 'payables', 'outstanding', 'receivable', 'receivables', 'advance', 'advances', 'prepaid', 'accrued',
]);

function hasBalanceSheetMarker(name: string): boolean {
  return rawTokens(name).some((token) => BALANCE_SHEET_MARKERS.has(token));
}

// For two tax ledgers "TDS Payable" and plain "TDS" name the same liability;
// only receivable (an asset: TDS deducted by customers) against payable
// separates them.
function markersDisagree(a: string, b: string): boolean {
  if (isTaxLedgerName(a) && isTaxLedgerName(b)) {
    const receivable = (name: string) => rawTokens(name).some((token) => token === 'receivable' || token === 'receivables');
    return receivable(a) !== receivable(b);
  }
  return hasBalanceSheetMarker(a) !== hasBalanceSheetMarker(b);
}

// Income against expense (2026-09-17): the alias "Interest" of Interest
// Income accepted "Interest Paid" by containment, and "Discount Allowed" is
// not "Discount Received". Only an income word against an expense word
// conflicts; a name with neither ("Rent") agrees with both.
const INCOME_WORDS = new Set(['income', 'incomes', 'received', 'receipt', 'receipts', 'earned', 'revenue']);
const EXPENSE_WORDS = new Set(['paid', 'expense', 'expenses', 'exp', 'allowed']);

function directionOf(name: string): 'income' | 'expense' | null {
  const tokens = rawTokens(name);
  const income = tokens.some((token) => INCOME_WORDS.has(token));
  const expense = tokens.some((token) => EXPENSE_WORDS.has(token));
  return income === expense ? null : income ? 'income' : 'expense';
}

export function directionsConflict(a: string, b: string): boolean {
  const first = directionOf(a);
  const second = directionOf(b);
  return first !== null && second !== null && first !== second;
}

// Which tax a name is about: its GST head, plain "gst", or "tds". "IGST
// Payable" is not "GST Payable" (2026-09-17: containment equated them).
function taxIdentityOf(name: string): string | null {
  const head = gstHeadOf(name);
  if (head) return head;
  if (/(?<![a-z])(?:ut)?gst(?![a-z])/i.test(name)) return 'gst';
  if (/(?<![a-z])tds(?![a-z])/i.test(name)) return 'tds';
  return null;
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

// GST payable ledgers (2026-09-17, round 2). The rulebook's 9B journal names
// one "GST Payable"; many companies keep a payable per head ("IGST
// Payable", "CGST Payable", "SGST Payable") and pay each head on its own
// challan line. Both are legitimate. A head-wise payable is never an Output,
// Input or RCM ledger: "Output IGST" credited as the liability is a
// different ledger and stays wrong.
function hasPayableWord(name: string): boolean {
  return rawTokens(name).some((token) => token === 'payable' || token === 'payables');
}

export function isGenericGstPayable(name: string): boolean {
  return taxIdentityOf(name) === 'gst' && hasPayableWord(name);
}

export function headWisePayableHead(name: string): 'CGST' | 'SGST' | 'IGST' | null {
  const head = gstHeadOf(name);
  if (head === null || !hasPayableWord(name)) return null;
  if (/\b(output|input|itc|rcm)\b/i.test(name)) return null;
  return head.toUpperCase() as 'CGST' | 'SGST' | 'IGST';
}

export function isGstPayableLedger(name: string): boolean {
  return isGenericGstPayable(name) || headWisePayableHead(name) !== null;
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

// Returns require their own ledger (user decision, 2026-09-16). An alias
// fits an account only when both are returns ledgers or neither is: the
// pilot pack aliased Sales Returns as "Sales" / "Credit Sales A/c" (netting
// a return into Sales), which the voucher check honoured while the Trial
// Balance tie-out and books reconciliation stripped it, so Template595's
// credit note posted to Credit Sales A/c was praised at voucher level and
// reported as "Sales Returns missing" on the Trial Balance. One predicate,
// applied wherever aliases are read, keeps every consumer in agreement.
export function aliasFitsAccount(alias: string, account: string): boolean {
  return RETURNS_TOKEN.test(alias) === RETURNS_TOKEN.test(account);
}

// Ledger classification shared by the books reconciliation and the Trial
// Balance tie-out (moved here from books-reconciliation.ts on 2026-09-11
// so the scorer can use it without an import cycle). Balance-sheet ledgers
// carry their balance across financial years; profit-and-loss ledgers are
// restarted by Tally at each new financial year.
export type LedgerKind = 'balance_sheet' | 'profit_and_loss' | 'tax' | 'unknown';

const BALANCE_SHEET_PATTERN =
  /\b(cash|bank|hdfc|capital|equipment|machinery|furniture|vehicle|computer|asset|loan|deposit|prepaid|outstanding|accrued|payable|receivable|suspense|advance|provision|stock|investment|drawings|reserve)\b/i;
const PROFIT_AND_LOSS_PATTERN =
  /\b(sales|purchases?|returns?|charges?|expenses?|fees?|rent|salar(y|ies)|wages|income|interest|depreciation|bad debts?|subscription|maintenance|advertis\w*|marketing|freight|delivery|packing|electricity|repairs?|discount|round[- ]?off|penalt\w*|late fee|commission|insurance|printing|stationery|travel|conveyance|telephone|internet|audit|legal|professional|consult\w*|cleaning|housekeeping|software|courier|postage|bonus|misc\w*|written off)\b/i;

// "Bank Charges", "Bank Interest", "Cash Discount": expense and income
// ledgers that carry a balance-sheet word (Garima's April: Bank Charges
// was read as a bank ledger and never restarted at the year change).
const BANK_CASH_PROFIT_AND_LOSS = /\b(bank|cash)\s+(charges?|fees?|commission|interest|discount)\b/i;

export function classifyLedger(account: string, partyAccounts: Set<string>): LedgerKind {
  if (isTaxLedgerName(account)) return 'tax';
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
    if (entry.bill_reference === null || isTaxLedgerName(entry.correct_account)) continue;
    if (CORE_PROFIT_AND_LOSS.test(entry.correct_account)) continue;
    const side = PARTY_SIDE[entry.voucher_type.trim().toLowerCase()];
    if (side !== undefined && entry.dr_cr !== side) continue;
    // A journal has no party side, and its expense leg carries the bill
    // reference too: "Dr Bad Debts Written Off / Cr Delhi Bazaar" against
    // INV-2231 made Bad Debts Written Off a party, so a month-only export
    // without that ledger was reported as "no ledger in your export"
    // (Praveen's June, 2026-09-21). Only the customer or supplier is a party.
    if (side === undefined && classifyLedger(entry.correct_account, new Set()) === 'profit_and_loss') continue;
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

// `keyAccounts` (2026-09-17, optional): the normalised account names of the
// answer key being scored. Two names that are BOTH distinct accounts of the
// key are never equated by the lenient rules ("Mehta Traders" posted where
// the key expects Mehra Traders, when Mehta Traders is a party of its own).
export type AccountMatchOptions = { keyAccounts?: ReadonlySet<string> };

export function keyAccountSet(accounts: Iterable<string>): Set<string> {
  return new Set([...accounts].map(normalizeAccountName));
}

export function accountNamesMatch(actual: string, expected: string, options: AccountMatchOptions = {}): boolean {
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
  if (options.keyAccounts?.has(a) && options.keyAccounts.has(b)) {
    return false;
  }
  const actualHead = gstHeadOf(actual);
  if (actualHead !== null && actualHead === gstHeadOf(expected)) {
    return true;
  }
  // Guards every lenient rule below must pass (2026-09-17).
  if (taxIdentityOf(actual) !== taxIdentityOf(expected)) {
    return false;
  }
  if (markersDisagree(actual, expected) || directionsConflict(actual, expected)) {
    return false;
  }
  // "Bank Charges" is an expense, "Bank"/"Cash" the asset: exactly one side
  // naming a bank/cash charge is a different account.
  if (BANK_CASH_PROFIT_AND_LOSS.test(actual) !== BANK_CASH_PROFIT_AND_LOSS.test(expected)) {
    return false;
  }
  if (sameAccountFamily(actual, expected)) {
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
  // A short name (under 6 significant chars: "Sales", "Bank") is contained
  // only as whole words (2026-09-17), so "Credit Sales A/c" still holds
  // "Sales" but a 5-letter name can no longer hide inside another word.
  if (shorter.length >= 6 && longer.includes(shorter)) {
    return true;
  }
  if (shorter.length === 5) {
    const shortTokens = significantTokens(shorter === a ? actual : expected);
    const longTokens = significantTokens(shorter === a ? expected : actual);
    if (shortTokens.length > 0 && shortTokens.every((token) => longTokens.includes(token))) {
      return true;
    }
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


// An alias of `account` accepts `ledger` only when it fits the account
// (returns rule), matches the ledger, and the ledger does not contradict the
// account itself on balance-sheet marker or income/expense direction
// (2026-09-17): the alias "Interest" of Interest Income must not accept
// "Interest Paid", nor an alias of Salaries accept "Salary Payable".
export function aliasAcceptsLedger(ledger: string, alias: string, account: string, options: AccountMatchOptions = {}): boolean {
  if (!aliasFitsAccount(alias, account)) return false;
  if (markersDisagree(ledger, account) || directionsConflict(ledger, account)) return false;
  const normalizedLedger = normalizeAccountName(ledger);
  if (options.keyAccounts?.has(normalizedLedger) && normalizedLedger !== normalizeAccountName(account) && normalizedLedger !== normalizeAccountName(alias)) {
    return false;
  }
  return accountNamesMatch(ledger, alias, options);
}

// Two names that no guard separates (2026-09-17): same tax identity, same
// returns status, balance-sheet markers and income/expense direction in
// agreement, and not a bank/cash charge against the bank or cash itself.
// The adjudicator requires this before it may excuse a naming finding.
export function namesCompatible(a: string, b: string): boolean {
  return (
    taxIdentityOf(a) === taxIdentityOf(b) &&
    RETURNS_TOKEN.test(a) === RETURNS_TOKEN.test(b) &&
    !markersDisagree(a, b) &&
    !directionsConflict(a, b) &&
    BANK_CASH_PROFIT_AND_LOSS.test(a) === BANK_CASH_PROFIT_AND_LOSS.test(b)
  );
}

// Words every business or ledger name may carry; sharing one of these says
// nothing about two names being the same account ("Kolkata Traders" and
// "Karnataka Traders").
const GENERIC_NAME_STEMS = new Set(
  [
    'trader', 'traders', 'enterprise', 'enterprises', 'industry', 'industries', 'pvt', 'private', 'ltd', 'limited',
    'llp', 'co', 'company', 'corporation', 'corp', 'supplier', 'suppliers', 'emporium', 'store', 'stores', 'agency',
    'agencies', 'service', 'services', 'solution', 'solutions', 'india', 'firm', 'brothers', 'bros', 'sons', 'group',
    'sale', 'sales', 'purchase', 'purchases', 'bank', 'cash', 'income', 'paid', 'received',
  ].map(stemToken),
);

export function shareDistinctiveToken(a: string, b: string): boolean {
  const first = significantTokens(a).filter((token) => !GENERIC_NAME_STEMS.has(token));
  const second = new Set(significantTokens(b).filter((token) => !GENERIC_NAME_STEMS.has(token)));
  return first.some((token) => second.has(token));
}

// A party's name leads with its proper name ("Balaji" Interiors, "Mysore"
// Decor); the trade word after it is shared by many parties ("Kolkata
// Interiors"). Two party names are variants only when the first distinctive
// word of the expected name appears in the other.
export function shareLeadingNameToken(ledger: string, party: string): boolean {
  const leading = rawTokens(party)
    .filter((token) => !FILLER_TOKENS.has(token))
    .map(stemToken)
    .find((token) => !GENERIC_NAME_STEMS.has(token));
  return leading !== undefined && significantTokens(ledger).includes(leading);
}
