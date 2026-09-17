import { describe, expect, it } from 'vitest';
import { classifyRectification, classifyRectificationsForExercise } from './rectification';
import type { ConceptAttempt } from '@/lib/db/queries/mastery';
import type { ConceptTag } from '@/lib/schemas/exercise';

const CONCEPT: ConceptTag = 'gst_classification';

function attempt(overrides: Partial<ConceptAttempt> & { created_at: string; result: 'pass' | 'fail' }): ConceptAttempt {
  return {
    id: `attempt-${overrides.created_at}`,
    learner_id: 'learner-1',
    exercise_id: `exercise-${overrides.created_at}`,
    submission_id: `submission-${overrides.created_at}`,
    concept_tag: CONCEPT,
    hint_rungs_used: 0,
    ...overrides,
  };
}

describe('classifyRectification', () => {
  it('classifies FIXED when the immediately prior attempt failed and this one passed', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'fail' }),
      attempt({ created_at: '2026-01-02', result: 'pass' }),
    ];

    const result = classifyRectification(CONCEPT, attempts);

    expect(result).toEqual({ conceptTag: CONCEPT, classification: 'FIXED', prior: 'earlier-batch' });
  });

  it('classifies STILL_FAILING when the immediately prior attempt failed and this one failed again', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'fail' }),
      attempt({ created_at: '2026-01-02', result: 'fail' }),
    ];

    const result = classifyRectification(CONCEPT, attempts);

    expect(result).toEqual({ conceptTag: CONCEPT, classification: 'STILL_FAILING', prior: 'earlier-batch' });
  });

  it('classifies NEW when this is the first-ever attempt and it failed', () => {
    const attempts = [attempt({ created_at: '2026-01-01', result: 'fail' })];

    const result = classifyRectification(CONCEPT, attempts);

    expect(result).toEqual({ conceptTag: CONCEPT, classification: 'NEW', prior: null });
  });

  it('produces no classification for a first-ever attempt that passed', () => {
    const attempts = [attempt({ created_at: '2026-01-01', result: 'pass' })];

    expect(classifyRectification(CONCEPT, attempts)).toBeNull();
  });

  it('produces no classification when passing twice in a row with no prior failure (steady progress, not spammed as a rectification event)', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'pass' }),
      attempt({ created_at: '2026-01-02', result: 'pass' }),
    ];

    expect(classifyRectification(CONCEPT, attempts)).toBeNull();
  });

  it('produces no classification for a fresh failure immediately after a pass (not a STILL FAILING recurrence)', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'pass' }),
      attempt({ created_at: '2026-01-02', result: 'fail' }),
    ];

    expect(classifyRectification(CONCEPT, attempts)).toBeNull();
  });

  it('returns null when there is no history at all for the concept', () => {
    expect(classifyRectification(CONCEPT, [])).toBeNull();
  });

  it('is order-independent — sorts by created_at before classifying', () => {
    const attempts = [
      attempt({ created_at: '2026-01-02', result: 'pass' }),
      attempt({ created_at: '2026-01-01', result: 'fail' }),
    ];

    const result = classifyRectification(CONCEPT, attempts);

    expect(result).toEqual({ conceptTag: CONCEPT, classification: 'FIXED', prior: 'earlier-batch' });
  });

  // 2026-09-16: a correction round re-scores the same exercise, so the prior
  // attempt can be an earlier round of THIS batch rather than a past batch.
  it('marks the prior attempt as a previous round when it belongs to the same exercise', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'fail', exercise_id: 'exercise-may' }),
      attempt({ created_at: '2026-01-02', result: 'fail', exercise_id: 'exercise-may' }),
    ];

    expect(classifyRectification(CONCEPT, attempts)).toEqual({
      conceptTag: CONCEPT,
      classification: 'STILL_FAILING',
      prior: 'previous-round',
    });
  });

  it('marks the prior attempt as an earlier batch when it belongs to a different exercise', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'fail', exercise_id: 'exercise-april' }),
      attempt({ created_at: '2026-01-02', result: 'pass', exercise_id: 'exercise-may' }),
    ];

    expect(classifyRectification(CONCEPT, attempts)).toEqual({
      conceptTag: CONCEPT,
      classification: 'FIXED',
      prior: 'earlier-batch',
    });
  });
});

// 2026-09-17: rounds of one exercise, and batches interleaved with them.
describe('classifyRectification with correction rounds', () => {
  it('compares a correction round with the previous round of the same exercise', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'pass', exercise_id: 'exercise-april' }),
      attempt({ created_at: '2026-01-02', result: 'fail', exercise_id: 'exercise-may' }),
      attempt({ created_at: '2026-01-03', result: 'fail', exercise_id: 'exercise-may' }),
      attempt({ created_at: '2026-01-04', result: 'pass', exercise_id: 'exercise-may' }),
    ];

    expect(classifyRectification(CONCEPT, attempts, 'exercise-may')).toEqual({
      conceptTag: CONCEPT,
      classification: 'FIXED',
      prior: 'previous-round',
    });
  });

  it('compares round 0 of a new batch with the final round of the previous batch', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'fail', exercise_id: 'exercise-april' }),
      attempt({ created_at: '2026-01-02', result: 'fail', exercise_id: 'exercise-april' }),
      attempt({ created_at: '2026-01-03', result: 'fail', exercise_id: 'exercise-may' }),
    ];

    expect(classifyRectification(CONCEPT, attempts, 'exercise-may')).toEqual({
      conceptTag: CONCEPT,
      classification: 'STILL_FAILING',
      prior: 'earlier-batch',
    });
  });

  it('a previous batch fixed in its correction rounds is not reported as still failing on the next batch', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'fail', exercise_id: 'exercise-april' }),
      attempt({ created_at: '2026-01-02', result: 'pass', exercise_id: 'exercise-april' }),
      attempt({ created_at: '2026-01-03', result: 'fail', exercise_id: 'exercise-may' }),
    ];

    expect(classifyRectification(CONCEPT, attempts, 'exercise-may')).toBeNull();
  });

  it('a late round of an older batch compares with its own previous round, not the newer batch', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'fail', exercise_id: 'exercise-april' }),
      attempt({ created_at: '2026-01-02', result: 'fail', exercise_id: 'exercise-may' }),
      attempt({ created_at: '2026-01-03', result: 'pass', exercise_id: 'exercise-april' }),
    ];

    expect(classifyRectification(CONCEPT, attempts, 'exercise-april')).toEqual({
      conceptTag: CONCEPT,
      classification: 'FIXED',
      prior: 'previous-round',
    });
    // Without an explicit exercise id the newest row's exercise is used.
    expect(classifyRectification(CONCEPT, attempts)).toEqual({
      conceptTag: CONCEPT,
      classification: 'FIXED',
      prior: 'previous-round',
    });
    // May still sits after April in the timeline, and April's final round passed.
    expect(classifyRectification(CONCEPT, attempts, 'exercise-may')).toBeNull();
  });

  it('returns null when the named exercise never tested the concept', () => {
    const attempts = [attempt({ created_at: '2026-01-01', result: 'fail', exercise_id: 'exercise-april' })];

    expect(classifyRectification(CONCEPT, attempts, 'exercise-may')).toBeNull();
  });
});

describe('classifyRectificationsForExercise', () => {
  it('classifies multiple concepts touched by one exercise and drops the ones with no classification', () => {
    const gst: ConceptTag = 'gst_classification';
    const tds: ConceptTag = 'tds_classification';
    const narration: ConceptTag = 'narration_discipline';

    const attempts = [
      { ...attempt({ created_at: '2026-01-01', result: 'fail' }), concept_tag: gst },
      { ...attempt({ created_at: '2026-01-02', result: 'pass' }), concept_tag: gst }, // FIXED
      { ...attempt({ created_at: '2026-01-01', result: 'fail' }), concept_tag: tds },
      { ...attempt({ created_at: '2026-01-02', result: 'fail' }), concept_tag: tds }, // STILL_FAILING
      { ...attempt({ created_at: '2026-01-01', result: 'pass' }), concept_tag: narration }, // no classification
    ];

    const results = classifyRectificationsForExercise([gst, tds, narration], attempts);

    expect(results).toEqual([
      { conceptTag: gst, classification: 'FIXED', prior: 'earlier-batch' },
      { conceptTag: tds, classification: 'STILL_FAILING', prior: 'earlier-batch' },
    ]);
  });
});
