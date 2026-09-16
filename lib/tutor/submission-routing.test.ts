import { describe, expect, it } from 'vitest';
import { REQUIRED_PARTS_BY_KIND } from '@/lib/schemas/exercise';
import { fileSubmissionEvents, textPartTypeFor } from './submission-routing';

describe('textPartTypeFor', () => {
  it('files typed text as the explanation on an explain exercise', () => {
    expect(textPartTypeFor(REQUIRED_PARTS_BY_KIND.explain)).toBe('explain_text');
  });

  it('files typed text as the review on a review exercise', () => {
    expect(textPartTypeFor(REQUIRED_PARTS_BY_KIND.review)).toBe('review_text');
  });

  it('has no text part for a files-only exercise', () => {
    expect(textPartTypeFor(REQUIRED_PARTS_BY_KIND.diagnostic)).toBeNull();
    expect(textPartTypeFor(REQUIRED_PARTS_BY_KIND.adaptive)).toBeNull();
    expect(textPartTypeFor([])).toBeNull();
  });

  it('prefers the explanation when both text parts are required', () => {
    expect(textPartTypeFor(['review_text', 'explain_text'])).toBe('explain_text');
  });
});

describe('fileSubmissionEvents', () => {
  it('sends a plain two-file exercise straight to scoring with one submission/uploaded event', () => {
    expect(fileSubmissionEvents('submission-1', REQUIRED_PARTS_BY_KIND.diagnostic)).toEqual({
      name: 'submission/uploaded',
      data: { submissionId: 'submission-1' },
    });
    expect(fileSubmissionEvents('submission-1', REQUIRED_PARTS_BY_KIND.adaptive)).toEqual({
      name: 'submission/uploaded',
      data: { submissionId: 'submission-1' },
    });
  });

  it('wakes the waiting job with one part-received event per file on a multi-part exercise', () => {
    expect(fileSubmissionEvents('submission-2', REQUIRED_PARTS_BY_KIND.explain)).toEqual([
      { name: 'submission/part-received', data: { submissionId: 'submission-2', partType: 'daybook_xml' } },
      { name: 'submission/part-received', data: { submissionId: 'submission-2', partType: 'trialbalance_xml' } },
    ]);
  });
});
