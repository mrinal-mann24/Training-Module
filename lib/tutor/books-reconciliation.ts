import { netAnswerKeys } from '@/lib/db/queries/company';
import type { AnswerKey } from '@/lib/schemas/exercise';
import type { TieOutMismatch } from '@/lib/schemas/scoring';
import type { ParsedTrialBalance } from '@/lib/schemas/voucher';
import { classifyLedger, normalizeAccountName, type LedgerKind } from './account-names';
import { exactlyClaimedRows, rowsForAccount, signedClosing } from './score-submission';

// Books reconciliation (2026-09-10 meeting: "it does not yet tell the
// intern how far their opening and closing balances are from the correct
// books"). Feedback only, never a score: after every scored posting the
// learner's Trial Balance closing balance of each ledger is compared with
// the correct books at the same point, and the ledgers that differ are
// named with the size of the gap. The movement tie-out judges the month;
// this shows the drift that Garima carried for a year without anyone
// saying so.
//
// Balance-sheet ledgers (parties, cash, bank, assets, capital, accruals,
// prepaid, suspense) compare cumulatively. Profit-and-loss ledgers compare
// year to date, because Tally restarts them at each financial year while
// the answer keys accumulate for ever: the expected figure is the sum of
// the keys in the same financial year as the batch. The timeline runs one
// batch per month from the April pack, so batches 0..11 are the first year,
// 12..23 the second. GST/TDS ledgers are exempt (the keys hold tax as
// metadata), and a ledger the patterns cannot classify is not reported.

// The classifier lives in account-names.ts (shared with the tie-out since
// 2026-09-11); re-exported here for its existing consumers.
export { classifyLedger };
export type { LedgerKind };

const TAX_PATTERN = /gst|tds/i;

export type ExpectedClosing = {
  account: string;
  kind: 'balance_sheet' | 'profit_and_loss';
  expected: number; // Dr positive
  aliases: string[];
};

const BATCHES_PER_YEAR = 12;

// `keys` are every answer key of the learner in timeline order; `ordinal` is
// the position of the batch being scored (0 = the April pack).
export function expectedClosingBalances(keys: AnswerKey[], ordinal: number): ExpectedClosing[] {
  const upToNow = keys.slice(0, ordinal + 1);
  const yearStart = Math.floor(ordinal / BATCHES_PER_YEAR) * BATCHES_PER_YEAR;
  const thisYear = keys.slice(yearStart, ordinal + 1);

  const parties = new Set<string>();
  const aliases = new Map<string, Set<string>>();
  const displayName = new Map<string, string>();
  for (const key of upToNow) {
    for (const entry of key.entries) {
      const norm = normalizeAccountName(entry.correct_account);
      if (!displayName.has(norm)) displayName.set(norm, entry.correct_account);
      if (entry.bill_reference !== null && !TAX_PATTERN.test(entry.correct_account)) parties.add(norm);
      for (const alias of entry.account_aliases ?? []) {
        const set = aliases.get(norm) ?? new Set<string>();
        set.add(alias);
        aliases.set(norm, set);
      }
    }
    for (const opening of key.opening_balances ?? []) {
      const norm = normalizeAccountName(opening.account);
      if (!displayName.has(norm)) displayName.set(norm, opening.account);
    }
  }

  const cumulative = netAnswerKeys(upToNow);
  const yearToDate = new Map<string, number>();
  for (const key of thisYear) {
    for (const entry of key.entries) {
      yearToDate.set(entry.correct_account, (yearToDate.get(entry.correct_account) ?? 0) + (entry.dr_cr === 'Dr' ? entry.amount : -entry.amount));
    }
  }

  const expected: ExpectedClosing[] = [];
  const seen = new Set<string>();
  const consider = (account: string, figure: number) => {
    const norm = normalizeAccountName(account);
    if (seen.has(norm)) return;
    const kind = classifyLedger(account, parties);
    if (kind === 'tax' || kind === 'unknown') return;
    seen.add(norm);
    expected.push({
      account: displayName.get(norm) ?? account,
      kind,
      expected: Math.round(figure * 100) / 100,
      aliases: [...(aliases.get(norm) ?? [])],
    });
  };
  for (const [account, figure] of cumulative) {
    if (classifyLedger(account, parties) === 'balance_sheet') consider(account, figure);
  }
  for (const [account, figure] of yearToDate) {
    if (classifyLedger(account, parties) === 'profit_and_loss') consider(account, figure);
  }
  return expected;
}

const RECONCILIATION_TOLERANCE = 1;

export type BooksReconciliation = { differences: TieOutMismatch[] };

export function evaluateBooksReconciliation(trialBalance: ParsedTrialBalance, expected: ExpectedClosing[]): BooksReconciliation {
  const namesByAccount = new Map<string, string[]>();
  for (const item of expected) namesByAccount.set(item.account, [item.account, ...item.aliases]);
  const claimed = exactlyClaimedRows(trialBalance, namesByAccount);
  const differences: TieOutMismatch[] = [];
  for (const item of expected) {
    const rows = rowsForAccount(trialBalance, namesByAccount.get(item.account) ?? [item.account], claimed);
    if (rows.length === 0) {
      if (Math.abs(item.expected) >= RECONCILIATION_TOLERANCE) {
        differences.push({ account: item.account, status: 'missing', difference: -item.expected });
      }
      continue;
    }
    const difference = Math.round((signedClosing(rows) - item.expected) * 100) / 100;
    if (Math.abs(difference) >= RECONCILIATION_TOLERANCE) {
      differences.push({ account: item.account, status: 'off', difference });
    }
  }
  differences.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
  return { differences };
}
