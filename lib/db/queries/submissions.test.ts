import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { markSubmissionFailedIfOpen, PROCESSING_FAILED_ERROR } from './submissions';

// Records the chain update().eq().in().select() and returns `rows` as the
// updated set, the way PostgREST reports which rows matched the WHERE clause.
function fakeClient(rows: { id: string }[]) {
  const select = vi.fn().mockResolvedValue({ data: rows, error: null });
  const inFilter = vi.fn().mockReturnValue({ select });
  const eq = vi.fn().mockReturnValue({ in: inFilter });
  const update = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ update });
  return { client: { from } as unknown as SupabaseClient, from, update, eq, inFilter };
}

describe('markSubmissionFailedIfOpen', () => {
  it('moves the submission to invalid with the processing error', async () => {
    const { client, from, update, eq } = fakeClient([{ id: 'sub-1' }]);

    await expect(markSubmissionFailedIfOpen(client, 'sub-1')).resolves.toBe(true);

    expect(from).toHaveBeenCalledWith('submissions');
    expect(update).toHaveBeenCalledWith({ status: 'invalid', validity_errors: [PROCESSING_FAILED_ERROR] });
    expect(eq).toHaveBeenCalledWith('id', 'sub-1');
  });

  // Both jobs can fail AFTER persisting a score (mastery recompute, next
  // exercise generation). The status guard must be in the update itself, so a
  // scored submission can never be flipped to invalid by that later failure.
  it('only ever touches a submission still validating or scoring', async () => {
    const { client, inFilter } = fakeClient([{ id: 'sub-1' }]);

    await markSubmissionFailedIfOpen(client, 'sub-1');

    expect(inFilter).toHaveBeenCalledWith('status', ['validating', 'scoring']);
  });

  it('reports false when the guard matched nothing, e.g. the submission was already scored', async () => {
    const { client } = fakeClient([]);

    await expect(markSubmissionFailedIfOpen(client, 'sub-1')).resolves.toBe(false);
  });

  it('tells the learner what to do, with no em dash', () => {
    expect(PROCESSING_FAILED_ERROR.code).toBe('processing_failed');
    expect(PROCESSING_FAILED_ERROR.message).toMatch(/send your files again/);
    expect(PROCESSING_FAILED_ERROR.message).not.toContain('—');
  });
});
