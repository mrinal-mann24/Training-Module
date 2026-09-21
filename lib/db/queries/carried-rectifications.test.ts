import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { AnswerKey } from '@/lib/schemas/exercise';
import { getPendingRectifications } from './carried-rectifications';

// Pre-launch review (2026-09-22): a rectification must ride in exactly one
// batch even when the stamp after insertExercise failed, and a badly written
// row must never block the learner's next batch.

const legs = [
  { account: 'Kolkata Emporium', dr_cr: 'Dr', amount: 34900, bill_reference: 'KE-305 (New Ref)' },
  { account: 'Suspense', dr_cr: 'Cr', amount: 34900, bill_reference: null },
];
const text = 'Reverse the excess Suspense clearing: debit Kolkata Emporium Rs 34,900 as a New Ref against bill KE-305 and credit Suspense Rs 34,900.';

function fakeClient(rows: unknown[]) {
  const updates: { values: Record<string, unknown>; ids: string[] }[] = [];
  const client = {
    from(table: string) {
      if (table === 'carried_rectifications') {
        return {
          select: () => ({ eq: () => ({ is: () => ({ order: async () => ({ data: rows, error: null }) }) }) }),
          update: (values: Record<string, unknown>) => ({
            in: (_column: string, ids: string[]) => ({
              is: async () => {
                updates.push({ values, ids });
                return { error: null };
              },
            }),
          }),
        };
      }
      // exercises: the key that already contains the rectification.
      return { select: () => ({ eq: () => ({ contains: () => ({ order: () => ({ limit: async () => ({ data: [{ id: 'exercise-1' }], error: null }) }) }) }) }) };
    },
  };
  return { client: client as unknown as SupabaseClient, updates };
}

describe('getPendingRectifications', () => {
  it('returns a well-formed pending row', async () => {
    const { client } = fakeClient([{ id: 'r1', learner_text: text, legs }]);
    const pending = await getPendingRectifications(client, 'learner', []);
    expect(pending.map((row) => row.id)).toEqual(['r1']);
  });

  it('never returns a row a saved key already carried, and repairs its stamp', async () => {
    const { client, updates } = fakeClient([{ id: 'r1', learner_text: text, legs }]);
    const priorKeys: AnswerKey[] = [{ entries: [], carried_rectification_ids: ['r1'] }];
    expect(await getPendingRectifications(client, 'learner', priorKeys)).toEqual([]);
    expect(updates).toHaveLength(1);
    expect(updates[0].ids).toEqual(['r1']);
    expect(updates[0].values.carried_in_exercise_id).toBe('exercise-1');
  });

  it('skips a badly written row with a loud log instead of throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unbalanced = [legs[0], { ...legs[1], amount: 100 }];
    const { client } = fakeClient([
      { id: 'bad-legs', learner_text: text, legs: unbalanced },
      { id: 'bad-shape', learner_text: text, legs: 'not an array' },
      { id: 'r2', learner_text: text, legs },
    ]);
    const pending = await getPendingRectifications(client, 'learner', []);
    expect(pending.map((row) => row.id)).toEqual(['r2']);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
