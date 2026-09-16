import { describe, expect, it, vi } from 'vitest';
import { insertConceptAttempts } from './mastery';
import type { ConceptTag } from '@/lib/schemas/exercise';

// Regression (2026-09-15, audit finding #3): insertConceptAttempts used a
// plain .insert(), so an Inngest step retry after the insert already
// succeeded (crash/timeout before the step completed) would duplicate the
// exercise's concept_attempts rows, silently inflating the
// consecutive-clean-streak count and shifting the escalation lookback
// window. This locks in that the write now goes through .upsert() with
// ignoreDuplicates against the (learner_id, exercise_id, concept_tag)
// unique constraint added in 20260915120000_idempotent_concept_attempts.sql
// — the actual dedup enforcement lives at the DB level; this test only
// pins the application code's request shape, since no local Supabase
// instance is available in this environment to exercise the constraint
// live (no Docker daemon running here).
function fakeSupabase() {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn().mockReturnValue({ upsert });
  return { from, upsert } as unknown as Parameters<typeof insertConceptAttempts>[0] & {
    from: typeof from;
    upsert: typeof upsert;
  };
}

describe('insertConceptAttempts', () => {
  it('upserts with ignoreDuplicates on (learner_id, exercise_id, concept_tag, submission_id) instead of a plain insert', async () => {
    const supabase = fakeSupabase();
    const attempts = [{ conceptTag: 'gst_classification' as ConceptTag, result: 'pass' as const, hintRungsUsed: 0 }];

    await insertConceptAttempts(supabase, 'learner-1', 'exercise-1', 'submission-1', attempts);

    expect(supabase.from).toHaveBeenCalledWith('concept_attempts');
    expect(supabase.upsert).toHaveBeenCalledWith(
      [
        {
          learner_id: 'learner-1',
          exercise_id: 'exercise-1',
          submission_id: 'submission-1',
          concept_tag: 'gst_classification',
          result: 'pass',
          hint_rungs_used: 0,
        },
      ],
      { onConflict: 'learner_id,exercise_id,concept_tag,submission_id', ignoreDuplicates: true },
    );
  });

  // The correction loop depends on this (2026-09-16): a second scoring of
  // the same exercise is a DIFFERENT submission, so it must write its own
  // row rather than being swallowed as a duplicate the way a retry is.
  it('writes a separate row for a corrected re-upload of the same exercise', async () => {
    const supabase = fakeSupabase();
    const attempts = [{ conceptTag: 'gst_classification' as ConceptTag, result: 'fail' as const, hintRungsUsed: 0 }];

    await insertConceptAttempts(supabase, 'learner-1', 'exercise-1', 'submission-1', attempts);
    await insertConceptAttempts(supabase, 'learner-1', 'exercise-1', 'submission-2', [
      { conceptTag: 'gst_classification' as ConceptTag, result: 'pass' as const, hintRungsUsed: 1 },
    ]);

    const [firstRows] = supabase.upsert.mock.calls[0];
    const [secondRows] = supabase.upsert.mock.calls[1];
    expect(firstRows[0].submission_id).toBe('submission-1');
    expect(secondRows[0].submission_id).toBe('submission-2');
    expect(secondRows).not.toEqual(firstRows);
  });

  it('calling it twice with the same arguments issues the same idempotent upsert both times (retry-safe)', async () => {
    const supabase = fakeSupabase();
    const attempts = [{ conceptTag: 'gst_classification' as ConceptTag, result: 'pass' as const, hintRungsUsed: 0 }];

    await insertConceptAttempts(supabase, 'learner-1', 'exercise-1', 'submission-1', attempts);
    await insertConceptAttempts(supabase, 'learner-1', 'exercise-1', 'submission-1', attempts);

    expect(supabase.upsert).toHaveBeenCalledTimes(2);
    const [firstCallArgs] = supabase.upsert.mock.calls[0];
    const [secondCallArgs] = supabase.upsert.mock.calls[1];
    expect(secondCallArgs).toEqual(firstCallArgs);
    // Both calls carry ignoreDuplicates: true, so a DB retry of this exact
    // call sequence writes the row at most once regardless of how many
    // times the step body re-runs.
    expect(supabase.upsert.mock.calls[0][1]).toMatchObject({ ignoreDuplicates: true });
    expect(supabase.upsert.mock.calls[1][1]).toMatchObject({ ignoreDuplicates: true });
  });
});
