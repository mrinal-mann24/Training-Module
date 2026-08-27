import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConceptTag } from '@/lib/schemas/exercise';
import type { StatePatch, ConceptMasteryStatus } from '@/lib/schemas/state-patch';

export type ConceptAttempt = {
  id: string;
  learner_id: string;
  exercise_id: string;
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
export async function insertConceptAttempts(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
  attempts: { conceptTag: ConceptTag; result: 'pass' | 'fail'; hintRungsUsed: number }[],
): Promise<void> {
  if (attempts.length === 0) {
    return;
  }

  const { error } = await supabase.from('concept_attempts').insert(
    attempts.map((attempt) => ({
      learner_id: learnerId,
      exercise_id: exerciseId,
      concept_tag: attempt.conceptTag,
      result: attempt.result,
      hint_rungs_used: attempt.hintRungsUsed,
    })),
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
    .select('id, learner_id, exercise_id, concept_tag, result, hint_rungs_used, created_at')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  return data ?? [];
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

// "Module number" for the progress label (Unit 09's UI note: "Module 3 ·
// Level 2") is derived, not stored — count of concepts currently mastered,
// plus 1. No module-numbering scheme is defined anywhere else in the spec,
// so this stays a simple progress indicator rather than a fixed curriculum
// position (confirmed with the user rather than inventing a grouping table).
export async function getModuleNumber(supabase: SupabaseClient, learnerId: string): Promise<number> {
  const { count, error } = await supabase
    .from('concept_mastery')
    .select('concept_tag', { count: 'exact', head: true })
    .eq('learner_id', learnerId)
    .eq('status', 'mastered');

  if (error) {
    throw error;
  }

  return (count ?? 0) + 1;
}

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
