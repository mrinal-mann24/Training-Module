import { describe, expect, it } from 'vitest';
import { STOCK_ITEMS_NOTE, formatExerciseContent } from './exercise-content';

describe('formatExerciseContent', () => {
  it('appends the stock-items note after the scenario and the numbered items', () => {
    const content = formatExerciseContent('Batch: same company.', '1. Buy goods.\n2. Sell goods.');
    expect(content).toBe(`Batch: same company.\n\n1. Buy goods.\n2. Sell goods.\n\n${STOCK_ITEMS_NOTE}`);
  });

  it('still appends the note when there are no item lines (pack exercises)', () => {
    expect(formatExerciseContent('Post the April pack.', '')).toBe(`Post the April pack.\n\n${STOCK_ITEMS_NOTE}`);
  });
});

import { EXPLAIN_PART_NOTE, REVIEW_PART_NOTE } from './exercise-content';

describe('formatExerciseContent: typed-part notes', () => {
  it('tells an explain exercise learner that a written explanation is required', () => {
    const content = formatExerciseContent('Batch.', '1. Buy.', ['daybook_xml', 'trialbalance_xml', 'explain_text']);
    expect(content.endsWith(`${STOCK_ITEMS_NOTE}\n\n${EXPLAIN_PART_NOTE}`)).toBe(true);
  });

  it('tells a review exercise learner that a written review is required', () => {
    expect(formatExerciseContent('Batch.', '', ['daybook_xml', 'trialbalance_xml', 'review_text'])).toContain(REVIEW_PART_NOTE);
  });

  it('adds no typed-part note for a plain two-file exercise', () => {
    const content = formatExerciseContent('Batch.', '1. Buy.', ['daybook_xml', 'trialbalance_xml']);
    expect(content).not.toContain('THREE parts');
  });
});
