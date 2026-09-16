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

// Records the upsert call so the conflict target can be asserted. The chain
// is upsert().select().single(), matching the real client.
function fakePartsClient() {
  const upsert = vi.fn().mockReturnValue({
    select: () => ({
      single: async () => ({
        data: {
          id: 'part-1',
          submission_id: 'submission-1',
          part_type: 'daybook_xml',
          content: { storage_path: 'p' },
          received_at: '2026-09-16T00:00:00.000Z',
        },
        error: null,
      }),
    }),
  });
  const client = { from: vi.fn().mockReturnValue({ upsert }) } as unknown as SupabaseClient;
  return { client, upsert };
}

describe('insertSubmissionPart', () => {
  // Second half of the re-send fix (2026-09-16). submitFiles rejoins an open
  // submission, so sending the two exports again re-records the same part
  // types for the same submission. As a plain insert that hit the table's
  // unique (submission_id, part_type) constraint and threw, reaching the
  // learner as a 500 rather than a message. Fixing only the Storage upsert
  // would have moved the failure from the upload to this line.
  it('upserts on (submission_id, part_type) so a re-sent part replaces its predecessor', async () => {
    const { client, upsert } = fakePartsClient();

    await insertSubmissionPart(client, 'submission-1', 'daybook_xml', { storage_path: 'p' });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ submission_id: 'submission-1', part_type: 'daybook_xml' }),
      { onConflict: 'submission_id,part_type' },
    );
  });

  // An upsert keeps the existing row's columns unless they are written, and
  // the chat's parts checklist reads received_at as "when this arrived".
  it('stamps received_at so the checklist shows the latest arrival, not the first', async () => {
    const { client, upsert } = fakePartsClient();

    await insertSubmissionPart(client, 'submission-1', 'daybook_xml', { storage_path: 'p' });

    const [row] = upsert.mock.calls[0];
    expect(typeof row.received_at).toBe('string');
    expect(Number.isNaN(Date.parse(row.received_at))).toBe(false);
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
