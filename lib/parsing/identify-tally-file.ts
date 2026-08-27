import { parseDayBookXml } from '@/lib/parsing/daybook';
import { parseTrialBalanceXml } from '@/lib/parsing/trialbalance';

export type TallyFileKind = 'daybook' | 'trialbalance' | 'unknown';

// GPT-style composer (2026-08-24): the learner attaches files through one
// generic upload control, so nothing labels which file is which — the
// CONTENT decides. A Day Book export has voucher structures, a Trial Balance
// has account-balance rows; the two are structurally unmistakable, so "which
// is which" is inferred by attempting each parse. Filenames are deliberately
// not consulted — learners name files anything.
export function identifyTallyFile(buffer: Buffer): TallyFileKind {
  try {
    const dayBook = parseDayBookXml(buffer);
    if (dayBook.vouchers.length > 0) {
      return 'daybook';
    }
  } catch {
    // Not a Day Book — fall through.
  }

  try {
    const trialBalance = parseTrialBalanceXml(buffer);
    if (trialBalance.ledgers.length > 0) {
      return 'trialbalance';
    }
  } catch {
    // Not a Trial Balance either.
  }

  return 'unknown';
}
