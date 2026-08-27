import type { SupabaseClient } from '@supabase/supabase-js';

export type LedgerReviewItemSource = 'real_transaction' | 'generated_distractor';

export type LedgerReviewItem = {
  id: string;
  exercise_id: string;
  source: LedgerReviewItemSource;
  company_transaction_log_id: string | null;
  anomaly_template_id: string | null;
  is_anomaly: boolean;
  presented_text: string;
};

export type NewLedgerReviewItem = {
  source: LedgerReviewItemSource;
  companyTransactionLogId: string | null;
  anomalyTemplateId: string | null;
  isAnomaly: boolean;
  presentedText: string;
};

// This is the review exercise's answer-key equivalent (is_anomaly must never
// be learner-writable) — service-role write only, same discipline as
// exercises.answer_key. Written once at generation time
// (generate-review-exercise.ts), immutable afterward per architecture.md
// invariant 6 (no code path here ever updates a row after insert).
export async function insertLedgerReviewItems(
  supabase: SupabaseClient,
  exerciseId: string,
  items: NewLedgerReviewItem[],
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const { error } = await supabase.from('ledger_review_items').insert(
    items.map((item) => ({
      exercise_id: exerciseId,
      source: item.source,
      company_transaction_log_id: item.companyTransactionLogId,
      anomaly_template_id: item.anomalyTemplateId,
      is_anomaly: item.isAnomaly,
      presented_text: item.presentedText,
    })),
  );

  if (error) {
    throw error;
  }
}

// Server-only: the review packet's real answer key. Must only ever be called
// from server-side qualitative-scoring code (score-qualitative.ts's caller),
// never exposed through any code path shaping a client-facing response —
// same hidden-answer-key discipline as getExerciseAnswerKey.
export async function getLedgerReviewItemsForExercise(
  supabase: SupabaseClient,
  exerciseId: string,
): Promise<LedgerReviewItem[]> {
  const { data, error } = await supabase
    .from('ledger_review_items')
    .select('id, exercise_id, source, company_transaction_log_id, anomaly_template_id, is_anomaly, presented_text')
    .eq('exercise_id', exerciseId)
    .order('id', { ascending: true });

  if (error) {
    throw error;
  }

  return data ?? [];
}
