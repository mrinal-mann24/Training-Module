import type { SupabaseClient } from '@supabase/supabase-js';
import { RectificationLegsSchema, type CarriedRectification } from '@/lib/tutor/carried-rectifications';

// Service-role only (the table has no policies): the generators read the
// learner's pending rectifications before building a batch and stamp them
// carried once the exercise row exists. A malformed row throws here, so the
// generation step fails loudly instead of skipping a correction.

export async function getPendingRectifications(supabase: SupabaseClient, learnerId: string): Promise<CarriedRectification[]> {
  const { data, error } = await supabase
    .from('carried_rectifications')
    .select('id, learner_text, legs')
    .eq('learner_id', learnerId)
    .is('carried_in_exercise_id', null)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => {
    const legs = RectificationLegsSchema.safeParse(row.legs);
    if (!legs.success) throw new Error(`carried_rectifications ${row.id}: legs are malformed (${legs.error.issues[0]?.message ?? 'schema'})`);
    return { id: row.id as string, learnerText: row.learner_text as string, legs: legs.data };
  });
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
