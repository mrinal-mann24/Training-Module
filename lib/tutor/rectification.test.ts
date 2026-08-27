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

    expect(result).toEqual({ conceptTag: CONCEPT, classification: 'FIXED' });
  });

  it('classifies STILL_FAILING when the immediately prior attempt failed and this one failed again', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'fail' }),
      attempt({ created_at: '2026-01-02', result: 'fail' }),
    ];

    const result = classifyRectification(CONCEPT, attempts);

    expect(result).toEqual({ conceptTag: CONCEPT, classification: 'STILL_FAILING' });
  });

  it('classifies NEW when this is the first-ever attempt and it failed', () => {
    const attempts = [attempt({ created_at: '2026-01-01', result: 'fail' })];

    const result = classifyRectification(CONCEPT, attempts);

    expect(result).toEqual({ conceptTag: CONCEPT, classification: 'NEW' });
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

    expect(result).toEqual({ conceptTag: CONCEPT, classification: 'FIXED' });
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
      { conceptTag: gst, classification: 'FIXED' },
      { conceptTag: tds, classification: 'STILL_FAILING' },
    ]);
  });
});
