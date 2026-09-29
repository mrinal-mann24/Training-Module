// How to export the two files from Tally, in ONE place (2026-09-29). Until
// now the steps existed only in messages the owner sent the interns by hand;
// the app said "export with ledger-level detail" and left the key presses to
// the learner. Every rejection now shows the steps for the file that is
// wrong, and every exercise says where the steps are.
//
// Pure data and string building: no imports, safe in the client bundle.
// Wording rules: simple words, no em dashes, nothing about the answers.
//
// The key presses are Tally Prime's. They are checked on a live Tally before
// any change here is released.

export type ExportKind = 'daybook' | 'trialbalance';

export const DAY_BOOK_EXPORT_STEPS: readonly string[] = [
  'In Tally, open Display More Reports, then Day Book.',
  'Press Alt+F2 and set the period to the month of this exercise, from its first day to its last day.',
  'Press Alt+F5 so the report is Detailed. Every voucher must show its ledger lines.',
  'Press Alt+E, choose Current, set the file format to XML, and export.',
];

export const TRIAL_BALANCE_EXPORT_STEPS: readonly string[] = [
  'In Tally, open Display More Reports, then Trial Balance.',
  'Press Alt+F2 and set the same month you used for the Day Book.',
  'Press F5 so the report is Ledger-wise. Every ledger must be on its own row, not grouped.',
  'Press F12 and set Show Opening Balance to Yes.',
  'Press Alt+E, choose Current, set the file format to XML, and export.',
];

const TITLES: Record<ExportKind, string> = {
  daybook: 'How to export the Day Book',
  trialbalance: 'How to export the Trial Balance',
};

const STEPS: Record<ExportKind, readonly string[]> = {
  daybook: DAY_BOOK_EXPORT_STEPS,
  trialbalance: TRIAL_BALANCE_EXPORT_STEPS,
};

export function exportSteps(kind: ExportKind): string {
  return `${TITLES[kind]}:\n${STEPS[kind].map((step, index) => `${index + 1}. ${step}`).join('\n')}`;
}

export function exportStepsFor(kinds: readonly ExportKind[]): string {
  const ordered = (['daybook', 'trialbalance'] as const).filter((kind) => kinds.includes(kind));
  return ordered.map(exportSteps).join('\n\n');
}

// The note under every exercise that is answered with the two files.
export const EXPORT_NOTE =
  'When you have posted everything, export the Day Book (Detailed) and the Trial Balance (Ledger-wise, with opening balances) for this month only, both as XML, and attach the two files here. If an upload is not accepted, I will show you the exact steps to export that file again.';

// A failure on our side: nothing for the learner to fix or export again.
const OUR_SIDE = new Set(['processing_failed', 'no_parts_received']);

// Which file's steps a rejection needs. A problem with how one file was
// exported needs that file's steps. A problem inside the vouchers is fixed
// in Tally first, and then both files are exported again.
const GUIDANCE: Record<string, readonly ExportKind[]> = {
  trial_balance_too_sparse: ['trialbalance'],
  day_book_not_detailed: ['daybook'],
  voucher_count_mismatch: ['daybook', 'trialbalance'],
  voucher_dates_out_of_period: ['daybook', 'trialbalance'],
  blank_vouchers: ['daybook', 'trialbalance'],
  parse_failed: ['daybook', 'trialbalance'],
};

export function guidanceFor(code: string): readonly ExportKind[] {
  if (OUR_SIDE.has(code)) return [];
  return GUIDANCE[code] ?? ['daybook', 'trialbalance'];
}

// The message a learner reads when an upload was not scored: what is wrong,
// then the steps for the file or files to export again.
export function formatRejection(errors: readonly { code: string; message: string }[] | null | undefined): string {
  const list = errors ?? [];
  const reasons = list.map((error) => `• ${error.message}`).join('\n');
  if (list.length > 0 && list.every((error) => OUR_SIDE.has(error.code))) {
    return reasons;
  }
  // No stored reason at all: both files, so the learner always has the steps.
  const kinds: ExportKind[] = list.length === 0 ? ['daybook', 'trialbalance'] : [...new Set(list.flatMap((error) => guidanceFor(error.code)))];
  const opening = list.length === 1 ? 'This upload could not be scored yet. One thing needs fixing:' : 'This upload could not be scored yet. These things need fixing:';
  const steps = exportStepsFor(kinds);
  return [opening, reasons, steps, 'Then attach both files here again.'].filter((part) => part.length > 0).join('\n\n');
}
