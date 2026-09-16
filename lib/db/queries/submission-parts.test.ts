import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { insertSubmissionPart, isSubmissionComplete, missingParts, type SubmissionPart } from './submission-parts';

function makePart(partType: SubmissionPart['part_type']): SubmissionPart {
  return {
    id: `part-${partType}`,
    submission_id: 'submission-1',
    part_type: partType,
    content: {},
    received_at: new Date().toISOString(),
  };
}

// Records the upsert call so its options can be asserted. The chain is
// upsert().select().maybeSingle(), matching the real client. `existing`
// simulates a conflict: DO NOTHING returns zero rows, so data is null.
function fakePartsClient(existing = false) {
  const row = {
    id: 'part-1',
    submission_id: 'submission-1',
    part_type: 'daybook_xml',
    content: { storage_path: 'p' },
    received_at: '2026-09-16T00:00:00.000Z',
  };
  const upsert = vi.fn().mockReturnValue({
    select: () => ({
      maybeSingle: async () => ({ data: existing ? null : row, error: null }),
    }),
  });
  const client = { from: vi.fn().mockReturnValue({ upsert }) } as unknown as SupabaseClient;
  return { client, upsert };
}

describe('insertSubmissionPart', () => {
  // submitFiles rejoins an open submission, so a re-send re-records the same
  // part types for the same submission. As a plain insert that hit the
  // table's unique (submission_id, part_type) constraint and reached the
  // learner as a 500.
  //
  // It MUST be ignoreDuplicates (ON CONFLICT DO NOTHING), not a plain upsert
  // (DO UPDATE). DO UPDATE is checked against an UPDATE policy, and
  // submission_parts has none: the first attempt at this fix used DO UPDATE
  // and failed live with 42501. Adding an UPDATE policy instead would let a
  // learner rewrite a confirmed explanation directly from the browser. If
  // this assertion is ever loosened, that failure comes straight back.
  it('ignores a duplicate instead of updating, so it needs only the INSERT policy', async () => {
    const { client, upsert } = fakePartsClient();

    await insertSubmissionPart(client, 'submission-1', 'daybook_xml', { storage_path: 'p' });

    expect(upsert).toHaveBeenCalledWith(
      { submission_id: 'submission-1', part_type: 'daybook_xml', content: { storage_path: 'p' } },
      { onConflict: 'submission_id,part_type', ignoreDuplicates: true },
    );
  });

  it('returns the new row on a first send', async () => {
    const { client } = fakePartsClient(false);

    await expect(
      insertSubmissionPart(client, 'submission-1', 'daybook_xml', { storage_path: 'p' }),
    ).resolves.toMatchObject({ submission_id: 'submission-1', part_type: 'daybook_xml' });
  });

  // The re-send itself: DO NOTHING returns zero rows. It has to resolve null,
  // not throw, or the normal self-healing retry becomes an error again.
  it('resolves null rather than throwing when the part is already recorded', async () => {
    const { client } = fakePartsClient(true);

    await expect(
      insertSubmissionPart(client, 'submission-1', 'daybook_xml', { storage_path: 'p' }),
    ).resolves.toBeNull();
  });
});

describe('isSubmissionComplete', () => {
  it('is false when a required part has not arrived yet', () => {
    const parts = [makePart('daybook_xml')];
    expect(isSubmissionComplete(parts, ['daybook_xml', 'trialbalance_xml', 'explain_text'])).toBe(false);
  });

  it('is true once every required part has a matching row, regardless of arrival order', () => {
    const parts = [makePart('explain_text'), makePart('daybook_xml'), makePart('trialbalance_xml')];
    expect(isSubmissionComplete(parts, ['daybook_xml', 'trialbalance_xml', 'explain_text'])).toBe(true);
  });

  it('is true for a review exercise once its single required part arrives', () => {
    const parts = [makePart('review_text')];
    expect(isSubmissionComplete(parts, ['review_text'])).toBe(true);
  });
});

describe('missingParts', () => {
  it('lists only the required parts that have not arrived', () => {
    const parts = [makePart('daybook_xml')];
    expect(missingParts(parts, ['daybook_xml', 'trialbalance_xml', 'explain_text'])).toEqual([
      'trialbalance_xml',
      'explain_text',
    ]);
  });

  it('returns an empty array once everything required has arrived', () => {
    const parts = [makePart('daybook_xml'), makePart('trialbalance_xml')];
    expect(missingParts(parts, ['daybook_xml', 'trialbalance_xml'])).toEqual([]);
  });
});
