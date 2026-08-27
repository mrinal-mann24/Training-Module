import { describe, expect, it } from 'vitest';
import { isSubmissionComplete, missingParts, type SubmissionPart } from './submission-parts';

function makePart(partType: SubmissionPart['part_type']): SubmissionPart {
  return {
    id: `part-${partType}`,
    submission_id: 'submission-1',
    part_type: partType,
    content: {},
    received_at: new Date().toISOString(),
  };
}

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
