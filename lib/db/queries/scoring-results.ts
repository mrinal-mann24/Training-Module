import type { SupabaseClient } from '@supabase/supabase-js';
import type { ScoringErrorCode, ScoringResult, OverallResult } from '@/lib/schemas/scoring';
import { normalizeStoredCoaching, type Coaching } from '@/lib/schemas/coaching';
import type { QualitativeScoring } from '@/lib/schemas/qualitative-scoring';

export type FeedbackForLearner = {
  overall_result: OverallResult;
  feedback_text: Coaching;
};

// Service-role write: scoring is computed server-side, learners have no
// insert/update RLS grant on this table (see the Unit 6 migration).
// Upserts on submission_id (unique constraint added in Unit 7's migration) so
// an Inngest step retry after a partial failure can't create a duplicate row
// for the same submission — the step is safe to re-run to completion.
//
// Unit 11: scoringResult is null for a 'review' exercise (no Tally posting
// at all) — weighted_score/tb_tie_out are persisted as 0/true in that case
// purely to satisfy the table's existing NOT NULL constraints (see the Unit
// 11 migration's comment on scoring_results.qualitative_score); overallResult
// is computed by the caller via combineOverallResult and is authoritative
// over scoringResult.overall_result when both are present (an explain
// exercise's qualitative signal can pull a clean voucher pass down to
// partial, or vice versa).
export async function insertScoringResult(
  supabase: SupabaseClient,
  params: {
    submissionId: string;
    exerciseId: string;
    learnerId: string;
    scoringResult: ScoringResult | null;
    errorCodes: ScoringErrorCode[];
    qualitativeScore: QualitativeScoring | null;
    overallResult: OverallResult;
    feedback: Coaching;
  },
): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('scoring_results')
    .upsert(
      {
        submission_id: params.submissionId,
        exercise_id: params.exerciseId,
        learner_id: params.learnerId,
        weighted_score: params.scoringResult?.weighted_score ?? 0,
        tb_tie_out: params.scoringResult?.tb_tie_out ?? true,
        error_codes: params.errorCodes,
        qualitative_score: params.qualitativeScore,
        overall_result: params.overallResult,
        feedback_text: params.feedback,
      },
      { onConflict: 'submission_id' },
    )
    .select('id')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

// Explicitly selects only overall_result and feedback_text — never
// error_codes or qualitative_score's raw subscores — regardless of what RLS
// would technically allow, same belt-and-suspenders pattern as
// getLatestDiagnosticExercise excluding answer_key in Unit 4.
export async function getFeedbackForLearner(
  supabase: SupabaseClient,
  submissionId: string,
): Promise<FeedbackForLearner | null> {
  const { data, error } = await supabase
    .from('scoring_results')
    .select('overall_result, feedback_text')
    .eq('submission_id', submissionId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  return {
    overall_result: data.overall_result,
    // Compat: rows written before the Phase 1 schema change carry the legacy
    // coaching shape; every read normalizes so the renderer sees one shape.
    feedback_text: normalizeStoredCoaching(data.feedback_text),
  };
}

export type FeedbackHistoryRow = {
  submission_id: string;
  overall_result: OverallResult;
  feedback_text: Coaching;
  created_at: string;
};

// Chat-history rebuild: every scored feedback for the learner, keyed by
// submission. Selects ONLY the learner-facing fields — never error_codes,
// weighted_score, or anything answer-key-adjacent, same boundary as
// getFeedbackForLearner above.
export async function getFeedbackHistoryForLearner(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<FeedbackHistoryRow[]> {
  const { data, error } = await supabase
    .from('scoring_results')
    .select('submission_id, overall_result, feedback_text, created_at')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => ({
    ...row,
    feedback_text: normalizeStoredCoaching(row.feedback_text),
  }));
}
