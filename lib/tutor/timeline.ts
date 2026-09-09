// The company's simulated timeline. One place for the anchor so the
// generator, the prompt, onboarding and the walkthrough cannot drift apart.
//
// 2026-09-09: moved from April 2026 to April 2024. AI Accountant refuses
// vouchers dated in the future and the simulated months had run ahead of
// real time (the interns were posting February 2027 in September 2026).
// Every intern's Tally company and every stored exercise/document were
// re-dated two years back in the same change (scripts/migrate-tally-books.ts,
// Downloads/patch-timeline-shift-2024.sql).
export const BOOKS_BEGIN_YEAR = 2024;
export const BOOKS_BEGIN_MONTH_INDEX = 3; // April (0-based)
export const BOOKS_BEGIN_DATE = `${BOOKS_BEGIN_YEAR}-04-01`;
export const BOOKS_BEGIN_LABEL = `01-Apr-${BOOKS_BEGIN_YEAR}`;
