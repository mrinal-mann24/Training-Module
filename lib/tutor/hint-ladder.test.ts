import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/db/queries/hint-requests', () => ({
  countHintRequestsForExercise: vi.fn(),
  getLatestDeepHintForExercise: vi.fn(),
}));

import {
  countHintRequestsForExercise,
  getLatestDeepHintForExercise,
  type HintRequest,
} from '@/lib/db/queries/hint-requests';
import { determineNextRung, findReusableDeepHint } from './hint-ladder';

const client = { client: 'user' } as unknown as SupabaseClient;

function storedDeepHint(overrides: Partial<HintRequest> = {}): HintRequest {
  return {
    id: 'hint-row-1',
    exercise_id: 'exercise-1',
    learner_id: 'learner-1',
    rung: 3,
    hint_content: { rung: 3, hint_text: 'Debit Rent, credit Bank for 25,000.', concept_tag: 'expense_booking' },
    created_at: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('determineNextRung', () => {
  it.each([
    [0, 1],
    [1, 2],
    [2, 3],
    [6, 3],
  ])('after %i prior requests the next step is %i', async (priorCount, expectedStep) => {
    vi.mocked(countHintRequestsForExercise).mockResolvedValue(priorCount);

    await expect(determineNextRung(client, 'learner-1', 'exercise-1')).resolves.toBe(expectedStep);
    expect(countHintRequestsForExercise).toHaveBeenCalledWith(client, 'learner-1', 'exercise-1');
  });
});

describe('findReusableDeepHint', () => {
  it.each([1, 2] as const)('never reuses anything on step %i and does not look', async (rung) => {
    await expect(findReusableDeepHint(client, 'learner-1', 'exercise-1', rung)).resolves.toBeNull();
    expect(getLatestDeepHintForExercise).not.toHaveBeenCalled();
  });

  it('returns null on step 3 when no full answer has been stored yet', async () => {
    vi.mocked(getLatestDeepHintForExercise).mockResolvedValue(null);

    await expect(findReusableDeepHint(client, 'learner-1', 'exercise-1', 3)).resolves.toBeNull();
    expect(getLatestDeepHintForExercise).toHaveBeenCalledWith(client, 'learner-1', 'exercise-1');
  });

  it('repeats the stored full answer on step 3', async () => {
    vi.mocked(getLatestDeepHintForExercise).mockResolvedValue(storedDeepHint());

    await expect(findReusableDeepHint(client, 'learner-1', 'exercise-1', 3)).resolves.toEqual({
      rung: 3,
      hint_text: 'Debit Rent, credit Bank for 25,000.',
      concept_tag: 'expense_booking',
    });
  });

  it('always reports the reused content as step 3, whatever rung it was stored with', async () => {
    vi.mocked(getLatestDeepHintForExercise).mockResolvedValue(
      storedDeepHint({ rung: 5, hint_content: { rung: 2, hint_text: 'Legacy worked answer.', concept_tag: 'gst' } }),
    );

    await expect(findReusableDeepHint(client, 'learner-1', 'exercise-1', 3)).resolves.toEqual({
      rung: 3,
      hint_text: 'Legacy worked answer.',
      concept_tag: 'gst',
    });
  });

  it('lets a failed lookup propagate', async () => {
    vi.mocked(getLatestDeepHintForExercise).mockRejectedValue(new Error('select failed'));

    await expect(findReusableDeepHint(client, 'learner-1', 'exercise-1', 3)).rejects.toThrow('select failed');
  });
});
