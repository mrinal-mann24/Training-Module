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
//
// 2026-09-17 audit:
// - A date-shaped run inside an identifier ("MS/12/06/2024",
//   "KE/15-06-2024", "INV-12-Jun-2024", "Invoice No. 17 Jun 2024") is a
//   document number, not a date: rewriting it made the text name a bill the
//   key does not have. Such tokens are never redated, and generation
//   rejects them (checkCanonicalDateFormat, looksLikeDate in
//   generation-checks.ts) so text and key cannot diverge.
// - "5th June 2024", "June 5, 2024", "2024-06-05", "05.06.2024" and
//   "15/06/24" are recognised, redated and asserted like the other shapes;
//   generation accepts only DD-Mon-YYYY in new batches.
// - The post-redate assertion covers the scenario prose and the key's
//   narrations as well as the transaction lines.

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

const MONTH_ALTERNATION = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
// "01-May-2024", "1 May 2024", "01/May/2024", "5th June 2024".
const NAMED_DATE_PATTERN = new RegExp(`\\b(\\d{1,2})((?:st|nd|rd|th)?[-\\s/.]*)(${MONTH_ALTERNATION})([a-z]*[-\\s/.,]*)(\\d{4})\\b`, 'gi');
// "June 5, 2024", "Jun 5 2024".
const MONTH_FIRST_PATTERN = new RegExp(`\\b(${MONTH_ALTERNATION})([a-z]*\\.?\\s+)(\\d{1,2})((?:st|nd|rd|th)?,?\\s+)(\\d{4})\\b`, 'gi');
// "2024-06-05".
const ISO_DATE_PATTERN = /\b(\d{4})([-/.])(\d{1,2})([-/.])(\d{1,2})\b/g;
// "05-06-2024", "05/06/2024", "05.06.2024", "15/06/24".
const NUMERIC_DATE_PATTERN = /\b(\d{1,2})([-/.])(\d{1,2})([-/.])(\d{4}|\d{2})\b/g;
const CANONICAL_DATE = new RegExp(`^\\d{1,2}-(?:${MONTH_ALTERNATION})-\\d{4}$`, 'i');

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

export type DateToken = {
  text: string;
  start: number;
  end: number;
  day: number;
  monthIndex: number;
  year: number;
  // Where the day digits sit inside `text`.
  dayOffset: number;
  dayLength: number;
  // Part of an identifier ("MS/12/06/2024"), not a date.
  embedded: boolean;
};

const IDENTIFIER_PREFIX = /(?:\b(?:no|nos|number|ref|inv|invoice|bill|memo|challan|voucher)\.?|#)\s*[:#]?\s*$/i;

function isEmbedded(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  const beforeTwo = text[start - 2];
  const after = text[end];
  const afterTwo = text[end + 1];
  const alnum = (character: string | undefined) => character !== undefined && /[A-Za-z0-9]/.test(character);
  if (alnum(before) || (before !== undefined && /[/\-_#.]/.test(before) && alnum(beforeTwo))) return true;
  if (alnum(after) || (after !== undefined && /[/\-_]/.test(after) && alnum(afterTwo))) return true;
  return IDENTIFIER_PREFIX.test(text.slice(Math.max(0, start - 24), start));
}

export function dateTokensIn(text: string): DateToken[] {
  const found: DateToken[] = [];
  const push = (match: RegExpMatchArray, day: string, dayOffset: number, monthIndex: number, year: number) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    found.push({
      text: match[0],
      start,
      end,
      day: Number(day),
      monthIndex,
      year,
      dayOffset,
      dayLength: day.length,
      embedded: isEmbedded(text, start, end),
    });
  };
  for (const match of text.matchAll(NAMED_DATE_PATTERN)) {
    push(match, match[1], 0, MONTH_ABBREVS.indexOf(match[3].toLowerCase()), Number(match[5]));
  }
  for (const match of text.matchAll(MONTH_FIRST_PATTERN)) {
    push(match, match[3], match[1].length + match[2].length, MONTH_ABBREVS.indexOf(match[1].toLowerCase()), Number(match[5]));
  }
  for (const match of text.matchAll(ISO_DATE_PATTERN)) {
    push(match, match[5], match[1].length + match[2].length + match[3].length + match[4].length, Number(match[3]) - 1, Number(match[1]));
  }
  for (const match of text.matchAll(NUMERIC_DATE_PATTERN)) {
    const year = match[5].length === 2 ? 2000 + Number(match[5]) : Number(match[5]);
    push(match, match[1], 0, Number(match[3]) - 1, year);
  }
  // Earliest first; an overlapping later match (the "24-06-05" inside
  // "2024-06-05") is dropped.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const tokens: DateToken[] = [];
  for (const token of found) {
    const previous = tokens[tokens.length - 1];
    if (previous && token.start < previous.end) continue;
    tokens.push(token);
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
// month (the generated diagnostic fallback). Identifier runs are left alone.
export function redateDescription(text: string, month: CalendarMonth | null): string {
  const inScope = (monthIndex: number, year: number): boolean =>
    monthIndex >= 0 && monthIndex <= 11 && (month === null || (monthIndex === month.monthIndex && year === month.year));
  let result = text;
  for (const token of [...dateTokensIn(text)].reverse()) {
    if (token.embedded || !inScope(token.monthIndex, token.year)) continue;
    const mapped = educationalDayFor(token.day, token.monthIndex, token.year);
    const dayText = token.text.slice(token.dayOffset, token.dayOffset + token.dayLength);
    // "5th" becomes "2nd", not "2th".
    const rest = token.text.slice(token.dayOffset + token.dayLength).replace(/^(st|nd|rd|th)/i, (suffix) => {
      const ordinal = mapped === 1 || mapped === 31 ? 'st' : mapped === 2 ? 'nd' : 'th';
      return suffix === suffix.toUpperCase() ? ordinal.toUpperCase() : ordinal;
    });
    const rewritten = `${token.text.slice(0, token.dayOffset)}${formatDay(dayText, mapped)}${rest}`;
    result = `${result.slice(0, token.start)}${rewritten}${result.slice(token.end)}`;
  }
  return result;
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

function datedTexts(generated: GeneratedExercise): { label: string; text: string }[] {
  return [
    ...generated.transactions.map((transaction) => ({ label: `transaction ${transaction.sequence}`, text: transaction.description })),
    { label: 'the scenario', text: generated.scenario },
    ...generated.answer_key.entries
      .filter((entry) => entry.narration !== null)
      .map((entry) => ({ label: `the narration of transaction ${entry.sequence}`, text: entry.narration ?? '' })),
  ];
}

export function checkEducationalDates(generated: GeneratedExercise, month: CalendarMonth | null): string | null {
  const offenders: string[] = [];
  for (const { label, text } of datedTexts(generated)) {
    for (const token of dateTokensIn(text)) {
      if (token.embedded) continue;
      // A 13th month is checkDatesExist's finding, not this one's.
      if (token.monthIndex < 0 || token.monthIndex > 11) continue;
      if (month !== null && (token.monthIndex !== month.monthIndex || token.year !== month.year)) continue;
      if (!isEducationalDay(token.day, token.monthIndex, token.year)) {
        offenders.push(`${label} is dated ${token.text}`);
      }
    }
  }
  if (offenders.length === 0) return null;
  return `Educational Mode dates violated: ${[...new Set(offenders)].join('; ')}. Tally Educational Mode only saves 01, 02 and 31 (only 01 and 02 in a month with no 31st).`;
}

// Impossible calendar dates (31-Jun, 30-Feb, a 13th month) for every
// learner: no Tally edition can save them, and the documents built from
// them would print a date that does not exist.
export function checkDatesExist(generated: GeneratedExercise): string | null {
  const offenders: string[] = [];
  for (const transaction of generated.transactions) {
    for (const token of dateTokensIn(transaction.description)) {
      if (token.embedded) continue;
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

// DD-Mon-YYYY only (2026-09-17 audit). The documents, the bank statement
// and the redating read dates out of the text; every other shape is either
// missed by one of them or read differently, and a date inside a document
// number is read as a date. Hard at generation.
export function checkCanonicalDateFormat(generated: GeneratedExercise): string | null {
  const offenders: string[] = [];
  const texts = [
    ...generated.transactions.map((transaction) => ({ label: `transaction ${transaction.sequence}`, text: transaction.description })),
    { label: 'the scenario', text: generated.scenario },
  ];
  for (const { label, text } of texts) {
    for (const token of dateTokensIn(text)) {
      if (token.embedded) {
        offenders.push(`${label} has a date inside an identifier near "${text.slice(Math.max(0, token.start - 8), token.end)}"`);
      } else if (!CANONICAL_DATE.test(token.text)) {
        offenders.push(`${label} writes the date "${token.text}"`);
      }
    }
  }
  if (offenders.length === 0) return null;
  return `Date format violated: ${offenders.join('; ')}. Write every date as DD-Mon-YYYY (e.g. 05-Jun-2024) and never put a date inside a bill, invoice or note number.`;
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
