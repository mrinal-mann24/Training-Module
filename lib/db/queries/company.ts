import type { SupabaseClient } from '@supabase/supabase-js';

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
