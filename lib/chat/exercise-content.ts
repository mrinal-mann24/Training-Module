// The exercise message a learner reads in the chat: the scenario story, the
// numbered items, then a fixed practical note. Shared by the server-side
// timeline and the client-side live append so the two can never drift.

// Invoices carry line items (fabric rolls, thread spools) to look real, but
// the evaluator scores ledgers only: account, Dr/Cr, amount, voucher type,
// GST, bill reference, narration. Stock items are never in the answer key.
// Live question 2026-09-02 (Praveen, Level 3): "do I have to create stock
// items?" — so every exercise now says it.
export const STOCK_ITEMS_NOTE =
  'Note: stock items are optional. Post invoices in accounting mode if you prefer; the evaluation checks ledgers, amounts, GST and bill references only.';

export function formatExerciseContent(
  scenario: string,
  itemLines: string,
): string {
  const body = itemLines ? `${scenario}\n\n${itemLines}` : scenario;
  return `${body}\n\n${STOCK_ITEMS_NOTE}`;
}
