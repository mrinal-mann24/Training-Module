import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnswerKey } from '@/lib/schemas/exercise';
import { RectificationLegsSchema, validateRectification, type CarriedRectification } from '@/lib/tutor/carried-rectifications';

// Service-role only (the table has no policies): the generators read the
// learner's pending rectifications before building a batch and stamp them
// carried once the exercise row exists.
//
// Two failure modes are closed here (pre-launch review, 2026-09-22):
// - The stamp is a second write after insertExercise. If it fails, the job
//   step retries, the "a newer exercise exists" guard returns early, and
//   the row would stay pending and ride in the NEXT batch too. The saved
//   key itself lists what it carried (answer_key.carried_rectification_ids,
//   same row as the key), so a row found there is never pending again, and
//   its stamp is repaired.
// - A row the owner wrote badly used to throw inside generation on every
//   attempt, on both engines, blocking the learner for good. It is now
//   skipped with a loud log; a wrong correction still never reaches a
//   learner, and the learner still gets their batch.

export async function getPendingRectifications(supabase: SupabaseClient, learnerId: string, priorKeys: readonly AnswerKey[]): Promise<CarriedRectification[]> {
  const { data, error } = await supabase
    .from('carried_rectifications')
    .select('id, learner_text, legs')
    .eq('learner_id', learnerId)
    .is('carried_in_exercise_id', null)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const alreadyCarried = new Set(priorKeys.flatMap((key) => key.carried_rectification_ids ?? []));
  const pending: CarriedRectification[] = [];
  for (const row of data ?? []) {
    const id = row.id as string;
    if (alreadyCarried.has(id)) {
      await repairCarriedStamp(supabase, learnerId, id);
      continue;
    }
    const legs = RectificationLegsSchema.safeParse(row.legs);
    const rectification = legs.success ? { id, learnerText: row.learner_text as string, legs: legs.data } : null;
    const problem = rectification ? validateRectification(rectification) : `rectification ${id}: legs are malformed (${legs.success ? '' : (legs.error.issues[0]?.message ?? 'schema')})`;
    if (!rectification || problem) {
      console.error(`[carried-rectifications] SKIPPED for learner ${learnerId}, fix the row: ${problem}`);
      continue;
    }
    pending.push(rectification);
  }
  return pending;
}

// Best effort: the key already proves the row was carried.
async function repairCarriedStamp(supabase: SupabaseClient, learnerId: string, rectificationId: string): Promise<void> {
  try {
    const { data } = await supabase
      .from('exercises')
      .select('id')
      .eq('learner_id', learnerId)
      .contains('answer_key', { carried_rectification_ids: [rectificationId] })
      .order('created_at', { ascending: true })
      .limit(1);
    const exerciseId = data?.[0]?.id as string | undefined;
    if (exerciseId) await markRectificationsCarried(supabase, [rectificationId], exerciseId);
  } catch (error) {
    console.error(`[carried-rectifications] could not repair the stamp of ${rectificationId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function markRectificationsCarried(supabase: SupabaseClient, ids: readonly string[], exerciseId: string): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from('carried_rectifications')
    .update({ carried_in_exercise_id: exerciseId, carried_at: new Date().toISOString() })
    .in('id', [...ids])
    .is('carried_in_exercise_id', null);
  if (error) throw error;
}
