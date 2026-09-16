import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConceptTag } from '@/lib/schemas/exercise';
import type { StatePatch, ConceptMasteryStatus } from '@/lib/schemas/state-patch';

export type ConceptAttempt = {
  id: string;
  learner_id: string;
  exercise_id: string;
  // Which submission produced this attempt (2026-09-16). Null only on rows
  // written before correction rounds existed whose scoring_results row has
  // since been deleted; every new row carries one.
  submission_id: string | null;
  concept_tag: ConceptTag;
  result: 'pass' | 'fail';
  hint_rungs_used: number;
  created_at: string;
};

export type ConceptMastery = {
  learner_id: string;
  concept_tag: ConceptTag;
  status: ConceptMasteryStatus;
  consecutive_clean_count: number;
  last_attempt_result: 'pass' | 'fail' | null;
  escalation_active: boolean;
  updated_at: string;
};

// Append-only: inserts one row per concept covered by a scored exercise.
// Never updated or deleted afterward — concept_mastery is derived from this
// log, this log is never derived from concept_mastery.
//
// Idempotent on (learner_id, exercise_id, concept_tag, submission_id) — an
// Inngest step retry after this call already succeeded once must not
// duplicate the submission's attempt rows (computeConceptResults already
// rolls up to one row per concept tag per submission, so a legitimate call
// never collides with itself; only a retry of the same call does, and
// ignoreDuplicates makes that a no-op).
//
// submission_id joined that key on 2026-09-16, when correction rounds made a
// second scoring of the SAME exercise a real event. Without it the guard was
// swallowing the correction: the upsert matched the round-0 row, ignored the
// new one, and the learner's fix was recorded nowhere. Keying on the
// submission keeps the retry guard and keeps concept_attempts the complete
// append-only trail invariant 5 requires.
export async function insertConceptAttempts(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
  submissionId: string,
  attempts: { conceptTag: ConceptTag; result: 'pass' | 'fail'; hintRungsUsed: number }[],
): Promise<void> {
  if (attempts.length === 0) {
    return;
  }

  const { error } = await supabase.from('concept_attempts').upsert(
    attempts.map((attempt) => ({
      learner_id: learnerId,
      exercise_id: exerciseId,
      submission_id: submissionId,
      concept_tag: attempt.conceptTag,
      result: attempt.result,
      hint_rungs_used: attempt.hintRungsUsed,
    })),
    { onConflict: 'learner_id,exercise_id,concept_tag,submission_id', ignoreDuplicates: true },
  );

  if (error) {
    throw error;
  }
}

// The full concept_attempts history for a learner, ordered oldest-first —
// mastery.ts's recompute logic needs the whole trail, not just the latest
// row, to evaluate "2 of last 3" / "3 total recent failures" rules per
// concept.
export async function getConceptAttempts(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<ConceptAttempt[]> {
  const { data, error } = await supabase
    .from('concept_attempts')
    .select('id, learner_id, exercise_id, submission_id, concept_tag, result, hint_rungs_used, created_at')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  return data ?? [];
}

// Whether any concept failed on one specific submission (2026-09-16). The
// chat asks this to decide whether a corrected re-upload is still on offer.
export async function hasFailedConceptForSubmission(
  supabase: SupabaseClient,
  learnerId: string,
  submissionId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('concept_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('learner_id', learnerId)
    .eq('submission_id', submissionId)
    .eq('result', 'fail');

  if (error) {
    throw error;
  }

  return (count ?? 0) > 0;
}

export async function getConceptMasteryMap(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<Map<ConceptTag, ConceptMastery>> {
  const { data, error } = await supabase
    .from('concept_mastery')
    .select('learner_id, concept_tag, status, consecutive_clean_count, last_attempt_result, escalation_active, updated_at')
    .eq('learner_id', learnerId);

  if (error) {
    throw error;
  }

  return new Map((data ?? []).map((row) => [row.concept_tag as ConceptTag, row as ConceptMastery]));
}

// getModuleNumber was removed on 2026-09-16. It derived a bare "Module N"
// label as the count of mastered concepts plus 1, which disagreed with the
// stored module_progress.current_module that /progress printed: the same
// learner could read "Module 3" in chat and "Module 7" on the progress page.
// Both are gone from the UI. The chat chip, the progress page and the
// dashboard bar now all derive their label from the mastery map through
// lib/tutor/major-modules.ts, so they cannot disagree. module_progress is
// still written and still gates advancement; it is simply not displayed.

// The one sanctioned write path for concept_mastery (architecture.md
// invariant 5) — only ever called from lib/tutor/mastery.ts's caller
// (the recompute step in run-scoring.ts), never from any other code path.
// Upserts one row per concept_tag delta in the patch.
export async function applyStatePatch(
  supabase: SupabaseClient,
  learnerId: string,
  patch: StatePatch,
): Promise<void> {
  if (patch.concept_mastery_deltas.length === 0) {
    return;
  }

  const escalationByTag = new Map(
    patch.escalation_changes.map((change) => [change.concept_tag, change.escalation_active]),
  );

  const rows = patch.concept_mastery_deltas.map((delta) => ({
    learner_id: learnerId,
    concept_tag: delta.concept_tag,
    status: delta.new_status,
    consecutive_clean_count: delta.consecutive_clean_count,
    last_attempt_result: delta.last_attempt_result,
    escalation_active: escalationByTag.get(delta.concept_tag) ?? false,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase.from('concept_mastery').upsert(rows, { onConflict: 'learner_id,concept_tag' });

  if (error) {
    throw error;
  }
}
