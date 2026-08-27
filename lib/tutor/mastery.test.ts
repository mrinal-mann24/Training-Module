import { describe, expect, it } from 'vitest';
import { recomputeMastery, checkReinforcement, selectWeakConcept, CLEAN_HELP_STEP_THRESHOLD } from './mastery';
import type { ConceptAttempt, ConceptMastery } from '@/lib/db/queries/mastery';
import type { ConceptTag } from '@/lib/schemas/exercise';

const CONCEPT: ConceptTag = 'gst_classification';

function attempt(
  overrides: Partial<ConceptAttempt> & { created_at: string; result: 'pass' | 'fail' },
): ConceptAttempt {
  return {
    id: `attempt-${overrides.created_at}`,
    learner_id: 'learner-1',
    exercise_id: `exercise-${overrides.created_at}`,
    concept_tag: CONCEPT,
    hint_rungs_used: 0,
    ...overrides,
  };
}

describe('recomputeMastery', () => {
  it('reaches mastered only after exactly 3 consecutive clean passes', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'pass' }),
      attempt({ created_at: '2026-01-02', result: 'pass' }),
    ];

    const afterTwo = recomputeMastery({ attempts, currentMastery: new Map() });
    expect(afterTwo.concept_mastery_deltas[0].new_status).toBe('developing');
    expect(afterTwo.concept_mastery_deltas[0].consecutive_clean_count).toBe(2);

    const afterThree = recomputeMastery({
      attempts: [...attempts, attempt({ created_at: '2026-01-03', result: 'pass' })],
      currentMastery: new Map(),
    });
    expect(afterThree.concept_mastery_deltas[0].new_status).toBe('mastered');
    expect(afterThree.concept_mastery_deltas[0].consecutive_clean_count).toBe(3);
  });

  it('does not count a pass toward the mastery streak when hint usage exceeds the clean threshold', () => {
    // Two clean passes, then a pass at heavy hint usage (rung 4+) — this
    // must NOT extend the streak to 3, even though the submission passed.
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'pass' }),
      attempt({ created_at: '2026-01-02', result: 'pass' }),
      attempt({ created_at: '2026-01-03', result: 'pass', hint_rungs_used: CLEAN_HELP_STEP_THRESHOLD }),
    ];

    const patch = recomputeMastery({ attempts, currentMastery: new Map() });

    expect(patch.concept_mastery_deltas[0].new_status).not.toBe('mastered');
    expect(patch.concept_mastery_deltas[0].consecutive_clean_count).toBe(0);
  });

  it('a hint-heavy pass below the threshold still counts as clean', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'pass', hint_rungs_used: CLEAN_HELP_STEP_THRESHOLD - 1 }),
      attempt({ created_at: '2026-01-02', result: 'pass' }),
      attempt({ created_at: '2026-01-03', result: 'pass' }),
    ];

    const patch = recomputeMastery({ attempts, currentMastery: new Map() });

    expect(patch.concept_mastery_deltas[0].new_status).toBe('mastered');
    expect(patch.concept_mastery_deltas[0].consecutive_clean_count).toBe(3);
  });

  it('a fail resets the consecutive clean streak to 0', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'pass' }),
      attempt({ created_at: '2026-01-02', result: 'pass' }),
      attempt({ created_at: '2026-01-03', result: 'fail' }),
    ];

    const patch = recomputeMastery({ attempts, currentMastery: new Map() });

    expect(patch.concept_mastery_deltas[0].consecutive_clean_count).toBe(0);
    expect(patch.concept_mastery_deltas[0].new_status).toBe('developing');
    expect(patch.concept_mastery_deltas[0].last_attempt_result).toBe('fail');
  });

  it('sets escalation_active once 3 total recent failures accumulate, not necessarily consecutive', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'fail' }),
      attempt({ created_at: '2026-01-02', result: 'pass' }),
      attempt({ created_at: '2026-01-03', result: 'fail' }),
      attempt({ created_at: '2026-01-04', result: 'pass' }),
      attempt({ created_at: '2026-01-05', result: 'fail' }),
    ];

    const patch = recomputeMastery({ attempts, currentMastery: new Map() });

    expect(patch.escalation_changes[0].escalation_active).toBe(true);
  });

  it('does not activate escalation with only 2 recent failures', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'fail' }),
      attempt({ created_at: '2026-01-02', result: 'pass' }),
      attempt({ created_at: '2026-01-03', result: 'fail' }),
    ];

    const patch = recomputeMastery({ attempts, currentMastery: new Map() });

    expect(patch.escalation_changes[0].escalation_active).toBe(false);
  });

  it('is idempotent: recomputing against the same attempts twice yields the same patch', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'pass' }),
      attempt({ created_at: '2026-01-02', result: 'fail' }),
    ];

    const first = recomputeMastery({ attempts, currentMastery: new Map() });
    const second = recomputeMastery({ attempts, currentMastery: new Map() });

    expect(second).toEqual(first);
  });
});

describe('checkReinforcement', () => {
  it('activates when 2 of the last 3 attempts on a concept failed', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'pass' }),
      attempt({ created_at: '2026-01-02', result: 'fail' }),
      attempt({ created_at: '2026-01-03', result: 'fail' }),
    ];

    expect(checkReinforcement(attempts, CONCEPT).reinforcementActive).toBe(true);
  });

  it('does not activate when only 1 of the last 3 attempts failed', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'pass' }),
      attempt({ created_at: '2026-01-02', result: 'pass' }),
      attempt({ created_at: '2026-01-03', result: 'fail' }),
    ];

    expect(checkReinforcement(attempts, CONCEPT).reinforcementActive).toBe(false);
  });

  it('only looks at the last 3 attempts, ignoring older ones', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'fail' }),
      attempt({ created_at: '2026-01-02', result: 'fail' }),
      attempt({ created_at: '2026-01-03', result: 'pass' }),
      attempt({ created_at: '2026-01-04', result: 'pass' }),
      attempt({ created_at: '2026-01-05', result: 'pass' }),
    ];

    expect(checkReinforcement(attempts, CONCEPT).reinforcementActive).toBe(false);
  });
});

describe('selectWeakConcept', () => {
  const ALL_TAGS: ConceptTag[] = ['sales_voucher_basics', 'purchase_voucher_basics', 'gst_classification'];

  it('returns null once every concept is mastered', () => {
    const masteryMap = new Map<ConceptTag, ConceptMastery>(
      ALL_TAGS.map((tag) => [
        tag,
        {
          learner_id: 'learner-1',
          concept_tag: tag,
          status: 'mastered',
          consecutive_clean_count: 3,
          last_attempt_result: 'pass',
          escalation_active: false,
          updated_at: '2026-01-01',
        },
      ]),
    );

    expect(selectWeakConcept(ALL_TAGS, [], masteryMap)).toBeNull();
  });

  it('prioritizes a reinforcement-active concept over an unstarted one', () => {
    const attempts = [
      attempt({ created_at: '2026-01-01', result: 'fail', concept_tag: 'purchase_voucher_basics' }),
      attempt({ created_at: '2026-01-02', result: 'fail', concept_tag: 'purchase_voucher_basics' }),
      attempt({ created_at: '2026-01-03', result: 'pass', concept_tag: 'purchase_voucher_basics' }),
    ];

    const target = selectWeakConcept(ALL_TAGS, attempts, new Map());

    expect(target?.conceptTag).toBe('purchase_voucher_basics');
    expect(target?.reason).toBe('reinforcement');
  });

  it('falls back to the lowest-status not-yet-mastered concept when nothing is reinforcement/escalation active', () => {
    const masteryMap = new Map<ConceptTag, ConceptMastery>([
      [
        'sales_voucher_basics',
        {
          learner_id: 'learner-1',
          concept_tag: 'sales_voucher_basics',
          status: 'developing',
          consecutive_clean_count: 1,
          last_attempt_result: 'pass',
          escalation_active: false,
          updated_at: '2026-01-01',
        },
      ],
    ]);

    const target = selectWeakConcept(ALL_TAGS, [], masteryMap);

    // purchase_voucher_basics and gst_classification are both not_started
    // (rank 0), sales_voucher_basics is developing (rank 1) — a not_started
    // concept should be picked over the developing one.
    expect(target?.conceptTag).not.toBe('sales_voucher_basics');
    expect(target?.reason).toBe('not_started_or_developing');
  });
});
