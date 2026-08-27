import { describe, expect, it } from 'vitest';
import { selectNextExerciseKind, MIN_LOG_ENTRIES_FOR_REVIEW } from './select-exercise-kind';

describe('selectNextExerciseKind', () => {
  it('keeps the early batches as plain adaptive posting work', () => {
    // Exercises 2 and 4 (after the diagnostic = 1).
    expect(selectNextExerciseKind({ priorExerciseCount: 1, companyTransactionLogCount: 0 })).toBe('adaptive');
    expect(selectNextExerciseKind({ priorExerciseCount: 3, companyTransactionLogCount: 10 })).toBe('adaptive');
  });

  it('schedules an explain batch as every 3rd exercise', () => {
    expect(selectNextExerciseKind({ priorExerciseCount: 2, companyTransactionLogCount: 0 })).toBe('explain');
    expect(selectNextExerciseKind({ priorExerciseCount: 5, companyTransactionLogCount: 0 })).toBe('explain');
  });

  it('schedules a review as every 5th exercise once the company has history', () => {
    expect(
      selectNextExerciseKind({ priorExerciseCount: 4, companyTransactionLogCount: MIN_LOG_ENTRIES_FOR_REVIEW }),
    ).toBe('review');
  });

  it('falls back to adaptive when a review is due but the company log is too sparse', () => {
    expect(
      selectNextExerciseKind({ priorExerciseCount: 4, companyTransactionLogCount: MIN_LOG_ENTRIES_FOR_REVIEW - 1 }),
    ).toBe('adaptive');
  });
});
