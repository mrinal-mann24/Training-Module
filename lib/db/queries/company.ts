import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnswerKey } from '@/lib/schemas/exercise';

// Cash and bank ledger recognition. The company's Cash-in-Hand ledger is
// plainly "Cash"; its bank ledger carries the bank's name ("HDFC Bank —
// 1234"). Group rows ("Cash-in-Hand", "Bank Accounts") never appear in an
// answer key, only ledgers do.
const CASH_ACCOUNT_PATTERN = /^cash\b|cash-in-hand/i;
const BANK_ACCOUNT_PATTERN = /\bbank\b|hdfc/i;
// "Bank Charges", "Bank Interest", "Bank Commission" are expense/income
// ledgers, not the bank. Counting them as bank inflated the stated opening
// by the charges balance (1,070.34): Yeshas's Level 2 prompt/prose said
// 8,67,186 for a real 8,66,116, Praveen's Level 4 8,09,246 for 8,08,176
// (2026-09-03). The answer keys were never affected — only the position
// fed to the generator and printed for the learner.
const NON_BANK_LEDGER_PATTERN = /charge|commission|interest|fee|penalt/i;

export function isBankLedger(account: string): boolean {
  return BANK_ACCOUNT_PATTERN.test(account) && !NON_BANK_LEDGER_PATTERN.test(account);
}

export type CompanyCashPosition = { cash: number; bank: number };

// The company's expected Cash and Bank balances after everything the learner
// has been asked to post so far, computed by netting the ANSWER KEYS (the
// correct position), not the learner's own possibly-miskeyed exports — an
// exercise has to be solvable by someone who posted correctly.
//
// Added 2026-09-02 after a live report: a generated batch opened with
// "deposit cash into HDFC Bank" for ₹45,000 when the learner's correct cash
// on hand was ₹19,900, because batch generation had no visibility into
// balances at all (company_transaction_log stores voucher types and ledger
// names, never amounts). Netted over her real data this returns 19,900,
// and her delivered batch drives it to -20,100 — the impossibility she
// spotted.
// Netting rule for the company's position across its answer keys. A key's
// opening_balances are the company's CUMULATIVE position at the start of
// that batch: the pack's openings on the diagnostic, the stamped
// carry-forward on every generated batch. They therefore RESET the running
// position before that batch's entries are applied. Adding them on top of
// the earlier keys counted April twice — live 2026-09-02: both Level 3 keys
// opened with HDFC at 18.2L instead of 9.5L and Praveen's till at -35,200
// instead of -55,100, which he spotted against his own Tally (his books were
// right; the key was wrong). Keys without openings (older batches) simply
// add their movements on top.
export function netAnswerKeys(keys: AnswerKey[]): Map<string, number> {
  let net = new Map<string, number>();
  const apply = (account: string, drCr: 'Dr' | 'Cr', amount: number) => {
    if (!account) {
      return;
    }
    net.set(account, (net.get(account) ?? 0) + (drCr === 'Dr' ? amount : -amount));
  };
  for (const key of keys) {
    if (key.opening_balances && key.opening_balances.length > 0) {
      net = new Map<string, number>();
      for (const opening of key.opening_balances) {
        apply(opening.account, opening.dr_cr, opening.amount);
      }
    }
    for (const entry of key.entries ?? []) {
      apply(entry.correct_account, entry.dr_cr, entry.amount);
    }
  }
  return net;
}

export function cashPositionFromNet(net: Map<string, number>): CompanyCashPosition {
  const position: CompanyCashPosition = { cash: 0, bank: 0 };
  for (const [account, signed] of net) {
    if (CASH_ACCOUNT_PATTERN.test(account)) {
      position.cash += signed;
    } else if (isBankLedger(account)) {
      position.bank += signed;
    }
  }
  return position;
}

async function loadAnswerKeys(supabase: SupabaseClient, learnerId: string): Promise<AnswerKey[]> {
  const { data, error } = await supabase
    .from('exercises')
    .select('answer_key')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? [])
    .map((row) => (row as { answer_key: AnswerKey | null }).answer_key)
    .filter((key): key is AnswerKey => key !== null);
}

export async function getExpectedCashPosition(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<CompanyCashPosition> {
  return cashPositionFromNet(netAnswerKeys(await loadAnswerKeys(supabase, learnerId)));
}


// GST/TDS ledgers are excluded from the carried-forward opening position:
// the answer-key model holds GST and TDS as voucher-level METADATA
// (gst_head/tds_section), not as ledger legs, so their balances cannot be
// derived from the keys — which is exactly why checkTrialBalanceTieOut
// already exempts them from comparison.
const TAX_LEDGER_PATTERN = /gst|tds/i;

export type OpeningBalance = { account: string; dr_cr: 'Dr' | 'Cr'; amount: number };

// The company's closing position across EVERY exercise so far, shaped as the
// opening balances of the next one. The learner works one continuous set of
// books — April's closing balances are May's opening balances — so a batch's
// expected closing has to be (carried-forward position + this batch's
// movements). Without this an adaptive batch's answer key described only its
// own movements while the learner's real Tally export is cumulative, so
// checkTrialBalanceTieOut failed even a flawless submission and capped every
// adaptive result at 'partial' (proved 2026-09-02: a 100%-correct May
// submission scored 100% with tb_tie_out false).
export function openingBalancesFromNet(net: Map<string, number>): OpeningBalance[] {
  return [...net.entries()]
    .filter(([account, signed]) => !TAX_LEDGER_PATTERN.test(account) && Math.abs(signed) >= 0.005)
    .map(([account, signed]) => ({
      account,
      dr_cr: signed > 0 ? ('Dr' as const) : ('Cr' as const),
      amount: Math.abs(signed),
    }));
}

export async function getExpectedOpeningBalances(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<OpeningBalance[]> {
  return openingBalancesFromNet(netAnswerKeys(await loadAnswerKeys(supabase, learnerId)));
}

export type CompanyLedgerRegistryEntry = {
  ledger_name: string;
  ledger_type: string;
  first_used_exercise_id: string;
  created_at: string;
};

export type CompanyTransactionLogEntry = {
  id: string;
  exercise_id: string;
  voucher_summary: unknown;
  created_at: string;
};

// Every ledger/party name ever introduced into the learner's single
// persistent Tally company — read before generating a new exercise so the
// LLM can reuse an existing name or guarantee a genuinely new one, per the
// spec's confirmed persistent-company design constraint.
export async function getCompanyLedgerRegistry(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<CompanyLedgerRegistryEntry[]> {
  const { data, error } = await supabase
    .from('company_ledger_registry')
    .select('ledger_name, ledger_type, first_used_exercise_id, created_at')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  return data ?? [];
}

// Ignores a name that's already registered (unique on learner_id+ledger_name)
// rather than erroring — a generated exercise reusing an existing ledger name
// on purpose (realistic continuity) shouldn't fail the write.
export async function registerCompanyLedgers(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
  ledgers: { ledgerName: string; ledgerType: string }[],
): Promise<void> {
  if (ledgers.length === 0) {
    return;
  }

  const { error } = await supabase
    .from('company_ledger_registry')
    .upsert(
      ledgers.map((ledger) => ({
        learner_id: learnerId,
        ledger_name: ledger.ledgerName,
        ledger_type: ledger.ledgerType,
        first_used_exercise_id: exerciseId,
      })),
      { onConflict: 'learner_id,ledger_name', ignoreDuplicates: true },
    );

  if (error) {
    throw error;
  }
}

// Most recent slice of what's been posted in the company, newest first —
// included in the next generation prompt as continuity context. Bounded so
// the prompt doesn't grow unboundedly as a learner's history lengthens.
const TRANSACTION_LOG_SLICE_SIZE = 10;

export async function getRecentCompanyTransactionLog(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<CompanyTransactionLogEntry[]> {
  const { data, error } = await supabase
    .from('company_transaction_log')
    .select('id, exercise_id, voucher_summary, created_at')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: false })
    .limit(TRANSACTION_LOG_SLICE_SIZE);

  if (error) {
    throw error;
  }

  return data ?? [];
}

// The learner's single persistent company name, read from the OLDEST log
// row — the pack assignment writes `company: pack.company_name` there
// (assign-pack-exercise.ts). The recent-slice query above returns the NEWEST
// rows, so the name silently fell out of the generation prompt once a
// learner accumulated 10+ log entries (user's 5-point batch review #5,
// 2026-09-01) — this reads it explicitly instead. Null when no pack has
// been assigned yet.
export async function getCompanyName(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('company_transaction_log')
    .select('voucher_summary')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const summary = data?.voucher_summary;
  if (summary && typeof summary === 'object' && 'company' in summary && typeof summary.company === 'string') {
    return summary.company;
  }
  return null;
}

export async function appendCompanyTransactionLog(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
  voucherSummary: unknown,
): Promise<void> {
  const { error } = await supabase.from('company_transaction_log').insert({
    learner_id: learnerId,
    exercise_id: exerciseId,
    voucher_summary: voucherSummary,
  });

  if (error) {
    throw error;
  }
}
