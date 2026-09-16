import type { GeneratedExercise } from '@/lib/schemas/exercise';

// Tally Educational Mode dates, enforced in code (2026-09-16). Most learners
// run TallyPrime in Educational Mode, which only saves vouchers dated the
// 1st, the 2nd or the 31st of a month. It never saves the 28th, 29th or
// 30th, even when that is the last day of the month (Tally help,
// "Work in Educational Mode"). So a 31-day month allows {1, 2, 31} and
// April, June, September, November and February allow only {1, 2}.
//
// Until now the rule lived only in the generation prompt, which no code
// checked, while the same prompt asked for dates spread across the month:
// a batch dated the 15th was unpostable for every educational learner.
// Every downstream date (invoice dates, bank statement rows and their
// yymmdd references, cash memo numbers, month-end notes, the sales
// register) is read from the transaction text, so redating that text
// before any document is built is enough to make the whole batch postable.

export type CalendarMonth = { monthIndex: number; year: number };

const MONTH_ABBREVS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// The same two token shapes checkBatchMonth and extractTransactionDate read:
// "01-May-2026" / "1 May 2026" / "01/May/2026", and numeric DD-MM-YYYY or
// DD/MM/YYYY. Capture groups keep every separator so a rewrite changes the
// day digits and nothing else.
const NAMED_DATE_PATTERN = /\b(\d{1,2})([-\s/]*)(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)([a-z]*[-\s/]*)(\d{4})\b/gi;
const NUMERIC_DATE_PATTERN = /\b(\d{1,2})([-/])(\d{1,2})([-/])(\d{4})\b/g;

export function daysInMonth(monthIndex: number, year: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function educationalDaysFor(monthIndex: number, year: number): number[] {
  return daysInMonth(monthIndex, year) === 31 ? [1, 2, 31] : [1, 2];
}

export function isEducationalDay(day: number, monthIndex: number, year: number): boolean {
  return educationalDaysFor(monthIndex, year).includes(day);
}

// Monotonic non-decreasing: a later day never maps to an earlier allowed
// day, so the batch keeps its chronological order and the bank statement
// (sorted by date, then sequence) keeps a consistent running balance.
// 1 -> 1; 2..16 -> 2; 17..31 -> 31 when the month has a 31st, else 2.
export function educationalDayFor(day: number, monthIndex: number, year: number): number {
  if (day <= 1) return 1;
  if (day <= 16) return 2;
  return daysInMonth(monthIndex, year) === 31 ? 31 : 2;
}

export function educationalDateLabels(month: CalendarMonth): string[] {
  return educationalDaysFor(month.monthIndex, month.year).map(
    (day) => `${String(day).padStart(2, '0')}-${MONTH_LABELS[month.monthIndex]}-${month.year}`,
  );
}

// "May 2026" -> { monthIndex: 4, year: 2026 }; null for anything else.
export function parseMonthLabel(label: string): CalendarMonth | null {
  const match = /^\s*([A-Za-z]+)\s+(\d{4})\s*$/.exec(label);
  if (!match) return null;
  const monthIndex = MONTH_NAMES.findIndex((name) => name.toLowerCase() === match[1].toLowerCase());
  return monthIndex === -1 ? null : { monthIndex, year: Number(match[2]) };
}

export function monthName(monthIndex: number): string {
  return MONTH_NAMES[monthIndex];
}

type DateToken = { text: string; day: number; monthIndex: number; year: number };

function dateTokens(text: string): DateToken[] {
  const tokens: DateToken[] = [];
  for (const match of text.matchAll(NAMED_DATE_PATTERN)) {
    tokens.push({
      text: match[0],
      day: Number(match[1]),
      monthIndex: MONTH_ABBREVS.indexOf(match[3].toLowerCase()),
      year: Number(match[5]),
    });
  }
  for (const match of text.matchAll(NUMERIC_DATE_PATTERN)) {
    tokens.push({ text: match[0], day: Number(match[1]), monthIndex: Number(match[3]) - 1, year: Number(match[5]) });
  }
  return tokens;
}

// Keeps the token's own style: "05" becomes "02", "5" becomes "2", and a
// single-digit "9" mapped to the 31st becomes "31".
function formatDay(original: string, day: number): string {
  return original.length >= 2 ? String(day).padStart(2, '0') : String(day);
}

// Rewrites every date token in the text to its Educational Mode day. With a
// month, only tokens of that month and year change (a token of another month
// is checkBatchMonth's business, not this function's). With null, every
// token is mapped within its own month, for batches with no single assigned
// month (the generated diagnostic fallback).
export function redateDescription(text: string, month: CalendarMonth | null): string {
  const inScope = (monthIndex: number, year: number): boolean =>
    monthIndex >= 0 && monthIndex <= 11 && (month === null || (monthIndex === month.monthIndex && year === month.year));

  const named = text.replace(
    NAMED_DATE_PATTERN,
    (whole: string, day: string, sep: string, abbrev: string, rest: string, year: string) => {
      const monthIndex = MONTH_ABBREVS.indexOf(abbrev.toLowerCase());
      if (!inScope(monthIndex, Number(year))) return whole;
      const mapped = educationalDayFor(Number(day), monthIndex, Number(year));
      return `${formatDay(day, mapped)}${sep}${abbrev}${rest}${year}`;
    },
  );
  return named.replace(
    NUMERIC_DATE_PATTERN,
    (whole: string, day: string, sep1: string, monthDigits: string, sep2: string, year: string) => {
      const monthIndex = Number(monthDigits) - 1;
      if (!inScope(monthIndex, Number(year))) return whole;
      const mapped = educationalDayFor(Number(day), monthIndex, Number(year));
      return `${formatDay(day, mapped)}${sep1}${monthDigits}${sep2}${year}`;
    },
  );
}

// Every generated text that carries per-transaction dates: the scenario
// prose (a numbered restatement there must still match the transaction for
// stripDuplicateTransactionList), each transaction line (the source of every
// document date), and the key's narrations.
export function redateForEducationalMode(generated: GeneratedExercise, month: CalendarMonth | null): GeneratedExercise {
  return {
    ...generated,
    scenario: redateDescription(generated.scenario, month),
    transactions: generated.transactions.map((transaction) => ({
      ...transaction,
      description: redateDescription(transaction.description, month),
    })),
    answer_key: {
      ...generated.answer_key,
      entries: generated.answer_key.entries.map((entry) =>
        entry.narration === null ? entry : { ...entry, narration: redateDescription(entry.narration, month) },
      ),
    },
  };
}

export function checkEducationalDates(generated: GeneratedExercise, month: CalendarMonth | null): string | null {
  const offenders: string[] = [];
  for (const transaction of generated.transactions) {
    for (const token of dateTokens(transaction.description)) {
      // A 13th month is checkDatesExist's finding, not this one's.
      if (token.monthIndex < 0 || token.monthIndex > 11) continue;
      if (month !== null && (token.monthIndex !== month.monthIndex || token.year !== month.year)) continue;
      if (!isEducationalDay(token.day, token.monthIndex, token.year)) {
        offenders.push(`transaction ${transaction.sequence} is dated ${token.text}`);
      }
    }
  }
  if (offenders.length === 0) return null;
  return `Educational Mode dates violated: ${offenders.join('; ')}. Tally Educational Mode only saves 01, 02 and 31 (only 01 and 02 in a month with no 31st).`;
}

// Impossible calendar dates (31-Jun, 30-Feb, a 13th month) for every
// learner: no Tally edition can save them, and the documents built from
// them would print a date that does not exist.
export function checkDatesExist(generated: GeneratedExercise): string | null {
  const offenders: string[] = [];
  for (const transaction of generated.transactions) {
    for (const token of dateTokens(transaction.description)) {
      if (token.monthIndex < 0 || token.monthIndex > 11) {
        offenders.push(`transaction ${transaction.sequence} is dated "${token.text}", which has no month ${token.monthIndex + 1}`);
        continue;
      }
      const days = daysInMonth(token.monthIndex, token.year);
      if (token.day < 1 || token.day > days) {
        offenders.push(
          `transaction ${transaction.sequence} is dated "${token.text}", but ${MONTH_NAMES[token.monthIndex]} ${token.year} has only ${days} days`,
        );
      }
    }
  }
  if (offenders.length === 0) return null;
  return `Impossible dates: ${offenders.join('; ')}. Use real calendar dates.`;
}

// Redate, then assert. The assertion should be unreachable (redating maps
// every in-scope token to an allowed day); it exists so a future token shape
// the patterns miss fails the job loudly instead of shipping an unpostable
// batch.
export function enforceEducationalDates(generated: GeneratedExercise, month: CalendarMonth | null): GeneratedExercise {
  const redated = redateForEducationalMode(generated, month);
  const remaining = checkEducationalDates(redated, month);
  if (remaining) {
    throw new Error(`Educational Mode redating left unpostable dates: ${remaining}`);
  }
  return redated;
}
