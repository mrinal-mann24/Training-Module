import { isBankLedger } from '@/lib/db/queries/company';
import type { AnswerKey } from '@/lib/schemas/exercise';
import type { LedgerFinding } from '@/lib/schemas/scoring';
import type { Voucher } from '@/lib/schemas/voucher';
import { accountNamesMatch, normalizeAccountName } from './account-names';

// Ledger set-up findings (2026-09-10 meeting), reported once per submission.
//
// 1. A GST ledger whose name states no side. Every intern ran one "CGST",
//    "SGST", "IGST" (Garima) or "Igst" (Yeshas) ledger for both purchases
//    and sales all year and nothing ever said so; the rulebook wants a
//    separate Input and Output ledger per head.
// 2. A second bank ledger for a one-bank company ("HDFC 123" alongside
//    "HDFC BANK", Garima from September). Any single bank ledger name is
//    accepted; a second one is the finding.
// 3. Two ledgers for one party: the full name on the invoice and a short
//    name on the receipt ("Karnataka Emporium" and "KAREMP"), so no receipt
//    ever cleared a bill. Detected among the ledgers this Day Book uses,
//    against the parties the answer key names (the legs carrying a bill
//    reference), by the same lenient name matching the scorer applies plus
//    an abbreviation test (consonant skeleton of the short name found in
//    order inside the party name).

const GST_HEAD_TOKEN = /\b(cgst|sgst|igst|utgst)\b/i;
const GST_SIDE_TOKEN = /\b(input|output|itc|payable|receivable|rcm|advance)\b/i;
const MIN_SKELETON_CHARS = 4;

function ledgerNamesUsed(vouchers: Voucher[]): string[] {
  const seen = new Map<string, string>();
  for (const voucher of vouchers) {
    for (const entry of voucher.ledgerEntries) {
      const key = normalizeAccountName(entry.ledgerName);
      if (key.length > 0 && !seen.has(key)) seen.set(key, entry.ledgerName.trim());
    }
  }
  return [...seen.values()];
}

function skeleton(name: string): string {
  return normalizeAccountName(name).replace(/[aeiou0-9]/g, '');
}

function isSubsequence(small: string, big: string): boolean {
  let i = 0;
  for (const ch of big) if (ch === small[i]) i += 1;
  return i === small.length;
}

// "KAREMP" for "Karnataka Emporium", "DBAZAAR" for "Delhi Bazaar": the
// short name's consonants appear in order inside the party name and both
// start with the same letter. Long enough to stay away from coincidence.
export function abbreviationMatches(shortName: string, partyName: string): boolean {
  const small = skeleton(shortName);
  const big = skeleton(partyName);
  if (small.length < MIN_SKELETON_CHARS || small.length >= big.length) return false;
  return small[0] === big[0] && isSubsequence(small, big);
}

// Generic, cash/bank and tax ledgers are never parties, whatever reference
// a generated key happens to hang on them.
const NON_PARTY_PATTERN = /^(sales|purchases?|cash|bank|hdfc|output|input|c?gst|sgst|igst|tds|suspense|sales returns?|purchase returns?)\b|gst|tds/i;

function partyAccounts(answerKey: AnswerKey): string[] {
  const parties = new Map<string, string>();
  for (const entry of answerKey.entries) {
    if (entry.bill_reference === null || NON_PARTY_PATTERN.test(entry.correct_account) || isBankLedger(entry.correct_account)) continue;
    const key = normalizeAccountName(entry.correct_account);
    if (!parties.has(key)) parties.set(key, entry.correct_account);
  }
  return [...parties.values()];
}

export function findLedgerFindings(vouchers: Voucher[], answerKey: AnswerKey): LedgerFinding[] {
  const findings: LedgerFinding[] = [];
  const names = ledgerNamesUsed(vouchers);

  const sidelessGst = names.filter((name) => GST_HEAD_TOKEN.test(name) && !GST_SIDE_TOKEN.test(name));
  if (sidelessGst.length > 0) {
    findings.push({ code: 'GST_LEDGER_NO_SIDE', ledgers: sidelessGst });
  }

  const bankLedgers = names.filter((name) => isBankLedger(name));
  const keyBankAccounts = new Set(
    answerKey.entries.map((entry) => entry.correct_account).filter((account) => isBankLedger(account)).map(normalizeAccountName),
  );
  if (bankLedgers.length > Math.max(1, keyBankAccounts.size)) {
    findings.push({ code: 'SECOND_BANK_LEDGER', ledgers: bankLedgers });
  }

  const duplicated: string[] = [];
  const claimed = new Set<string>();
  for (const party of partyAccounts(answerKey)) {
    const matches = names.filter(
      (name) => !claimed.has(name) && (accountNamesMatch(name, party) || abbreviationMatches(name, party)),
    );
    if (matches.length > 1) {
      for (const name of matches) claimed.add(name);
      duplicated.push(...matches);
    }
  }
  if (duplicated.length > 0) {
    findings.push({ code: 'DUPLICATE_PARTY_LEDGER', ledgers: duplicated });
  }

  return findings;
}
