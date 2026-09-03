import type { ParsedDayBook, ParsedTrialBalance } from '@/lib/schemas/voucher';
import type { ExerciseForLearner } from '@/lib/db/queries/exercises';
import { extractTransactionDate } from '@/lib/llm/prompts/source-document';

export type ValidityError = {
  code: string;
  message: string;
};

export type ValidityGateResult =
  | { status: 'valid' }
  | { status: 'invalid'; errors: ValidityError[] };

// ASSUMPTION: a Trial Balance export with only a handful of rows is, by
// definition, group-level-only rather than ledger-level — a real chart of
// accounts used across an exercise's transactions has far more distinct
// ledgers than this. The spec's own sample (2 rows: "Current Liabilities",
// "Purchase Accounts" — Tally group names, not specific ledgers) is the
// sparse case being rejected here. The export format has no tag that
// distinguishes "group" from "ledger" rows structurally, so a minimum count
// is the only available structural signal. Revisit this threshold once a
// real ledger-level sample is available to calibrate against.
// A group-wise Trial Balance export (Capital Account, Current Liabilities,
// Sales Accounts…) has 9-10 rows; even the smallest ledger-wise export of
// this company has 35+. The old floor of 3 let group-wise files through
// (Yeshas's May, 2026-09-03) and the tie-out then matched nothing. 15 keeps
// every real ledger-wise export and rejects every group-wise one seen.
const MIN_TRIAL_BALANCE_LEDGER_ROWS = 15;

// Runs after both files have parsed successfully. Checks are structural only —
// nothing here reads exercise.answer_key, since scoring doesn't exist until Unit 06.
export function runValidityGate(
  dayBook: ParsedDayBook,
  trialBalance: ParsedTrialBalance,
  exercise: ExerciseForLearner,
  booksBeginDate: string,
): ValidityGateResult {
  const errors: ValidityError[] = [];

  if (trialBalance.ledgers.length < MIN_TRIAL_BALANCE_LEDGER_ROWS) {
    errors.push({
      code: 'trial_balance_too_sparse',
      message:
        'This Trial Balance only shows a few account groups, not individual ledger accounts. In Tally, export the Trial Balance with ledger-level detail (not a summarized group view), then upload it again.',
    });
  }

  const voucherDateError = checkVoucherDatesInPeriod(dayBook, booksBeginDate, exercise);
  if (voucherDateError) {
    errors.push(voucherDateError);
  }

  const voucherCountError = checkVoucherCount(dayBook, exercise);
  if (voucherCountError) {
    errors.push(voucherCountError);
  }

  if (errors.length > 0) {
    return { status: 'invalid', errors };
  }

  return { status: 'valid' };
}

function parseTallyDate(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

// The exercise timeline runs one calendar month per batch, so it outruns the
// wall clock: Praveen's Level 6 is dated September 2026 and was exported on
// 3 September 2026 — the old "never in the future" rule rejected it
// (2026-09-03). The window now ends at the later of today and the end of
// the latest month the exercise's own transactions name; wrong years are
// still caught.
function exercisePeriodEnd(exercise: ExerciseForLearner): Date {
  let end = new Date();
  for (const transaction of exercise.transactions) {
    const date = extractTransactionDate(transaction.description);
    if (!date) continue;
    const monthEnd = new Date(Date.UTC(date.year, date.monthIndex + 1, 0, 23, 59, 59));
    if (monthEnd > end) end = monthEnd;
  }
  return end;
}

function checkVoucherDatesInPeriod(
  dayBook: ParsedDayBook,
  booksBeginDate: string,
  exercise: ExerciseForLearner,
): ValidityError | null {
  const periodStart = new Date(booksBeginDate);
  const periodEnd = exercisePeriodEnd(exercise);

  const outOfRange = dayBook.vouchers.some((voucher) => {
    const voucherDate = parseTallyDate(voucher.date);
    if (!voucherDate) {
      return true;
    }
    return voucherDate < periodStart || voucherDate > periodEnd;
  });

  if (outOfRange) {
    return {
      code: 'voucher_dates_out_of_period',
      message:
        'Some vouchers in this Day Book fall outside your Books Begin Date or are dated in the future. Check the dates on each voucher in Tally, correct any that are wrong, and re-export.',
    };
  }

  return null;
}

// Pack exercises tolerate a small voucher-count deviation instead of
// requiring exact equality. On a ~100-voucher realistic month, legitimate
// bookkeeping-style differences change the count (an opening JV instead of
// ledger-creation openings, month-end adjustment JVs combined or split,
// per-bill payments instead of one split payment) — the pilot programme's
// reviewer scored Elina's 99-voucher daybook against a 98-voucher key
// without bouncing it, and the engine handles the difference anyway
// (similarity matching + VOUCHER_MISSING scoring). The gate still rejects
// a submission that is OBVIOUSLY incomplete (outside the tolerance band).
// Generated drills (no expectedVoucherCount) keep the exact check: at 3-8
// transactions, any mismatch really does mean a skipped/extra posting.
const PACK_VOUCHER_COUNT_TOLERANCE = 0.1;

function checkVoucherCount(
  dayBook: ParsedDayBook,
  exercise: ExerciseForLearner,
): ValidityError | null {
  // Unit 14R: a pack exercise's transactions live inside its authored files,
  // not in exercise.transactions — expectedVoucherCount (set at pack
  // assignment from the authored answer key) is the count source for those.
  const expectedCount = exercise.expectedVoucherCount ?? exercise.transactions.length;
  const actualCount = dayBook.vouchers.length;

  if (exercise.expectedVoucherCount !== null) {
    const allowedDeviation = Math.ceil(expectedCount * PACK_VOUCHER_COUNT_TOLERANCE);
    if (Math.abs(actualCount - expectedCount) > allowedDeviation) {
      return {
        code: 'voucher_count_mismatch',
        message: `This exercise works out to around ${expectedCount} vouchers, but the Day Book export contains ${actualCount}: that looks like a big chunk is missing or a different period was exported. Check the export covers the full month, then resubmit.`,
      };
    }
    return null;
  }

  if (actualCount !== expectedCount) {
    return {
      code: 'voucher_count_mismatch',
      message: `This exercise has ${expectedCount} transaction${expectedCount === 1 ? '' : 's'} to post, but the Day Book export contains ${actualCount}. Check you've posted all of them (and only them) in Tally, then re-export and resubmit.`,
    };
  }

  return null;
}
