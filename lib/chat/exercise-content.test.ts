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
