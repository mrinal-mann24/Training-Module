// The exercise message a learner reads in the chat: the scenario story, the
// numbered items, then fixed practical notes. Shared by the server-side
// timeline and the client-side live append so the two can never drift.

// Invoices carry line items (fabric rolls, thread spools) to look real, but
// the evaluator scores ledgers only: account, Dr/Cr, amount, voucher type,
// GST, bill reference, narration. Stock items are never in the answer key.
// Live question 2026-09-02 (Praveen, Level 3): "do I have to create stock
// items?" — so every exercise now says it.
export const STOCK_ITEMS_NOTE =
  'Note: stock items are optional. Post invoices in accounting mode if you prefer; the evaluation checks ledgers, amounts, GST and bill references only.';

// Explain/review exercises need a typed part as well as the two XML files.
// Until 2026-09-03 the only hint was the composer placeholder, so the first
// learner through an explain batch uploaded the files and waited, asking
// "what should I explain?" while the job sat in its 45-minute window.
export const EXPLAIN_PART_NOTE =
  'This level has THREE parts: the Day Book XML, the Trial Balance XML, and a short written explanation. After uploading the two files, type in the chat box why you posted each entry the way you did (voucher type, ledgers, GST, bill reference), then send it. Scoring starts once all three are in.';

export const REVIEW_PART_NOTE =
  'This level has THREE parts: the Day Book XML, the Trial Balance XML, and your written ledger review. After uploading the two files, type in the chat box which entries are wrong and why, then send it. Scoring starts once all three are in.';

export function formatExerciseContent(
  scenario: string,
  itemLines: string,
  requiredParts: readonly string[] = [],
): string {
  const body = itemLines ? `${scenario}\n\n${itemLines}` : scenario;
  const notes = [STOCK_ITEMS_NOTE];
  if (requiredParts.includes('explain_text')) {
    notes.push(EXPLAIN_PART_NOTE);
  } else if (requiredParts.includes('review_text')) {
    notes.push(REVIEW_PART_NOTE);
  }
  return `${body}\n\n${notes.join('\n\n')}`;
}
