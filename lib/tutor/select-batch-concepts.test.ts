import { describe, expect, it } from 'vitest';
import { selectBatchConcepts } from './select-batch-concepts';
import type { ConceptAttempt, ConceptMastery } from '@/lib/db/queries/mastery';
import type { ConceptTag } from '@/lib/schemas/exercise';
import type { WeakConceptTarget } from '@/lib/tutor/mastery';

function target(conceptTag: ConceptTag, escalationActive = false): WeakConceptTarget {
  return { conceptTag, reason: 'not_started_or_developing', reinforcementActive: false, escalationActive };
}

function attempt(conceptTag: ConceptTag, result: 'pass' | 'fail', createdAt: string): ConceptAttempt {
  return {
    id: `${conceptTag}-${createdAt}`,
    learner_id: 'learner-1',
    exercise_id: 'ex-1',
    concept_tag: conceptTag,
    result,
    hint_rungs_used: 0,
    created_at: createdAt,
  };
}

function mastery(
  conceptTag: ConceptTag,
  overrides: Partial<ConceptMastery> = {},
): [ConceptTag, ConceptMastery] {
  return [
    conceptTag,
    {
      learner_id: 'learner-1',
      concept_tag: conceptTag,
      status: 'developing',
      consecutive_clean_count: 0,
      last_attempt_result: null,
      escalation_active: false,
      updated_at: '2026-08-25T00:00:00Z',
      ...overrides,
    },
  ];
}

describe('selectBatchConcepts', () => {
  it('a fresh learner gets only the primary target as weakness, no strengths', () => {
    const plan = selectBatchConcepts(target('gst_classification'), [], new Map());
    expect(plan).toEqual({ strengths: [], weaknesses: ['gst_classification'] });
  });

  it('splits latest-fail concepts into weaknesses and clean/mastered into strengths', () => {
    const attempts = [
      attempt('tds_classification', 'fail', '2026-08-01'),
      attempt('bill_by_bill_referencing', 'pass', '2026-08-01'),
      attempt('narration_discipline', 'fail', '2026-08-02'),
    ];
    const masteryMap = new Map([
      mastery('bill_by_bill_referencing', { status: 'mastered' }),
      mastery('sales_voucher_basics', { consecutive_clean_count: 2 }),
    ]);
    const plan = selectBatchConcepts(target('gst_classification'), attempts, masteryMap);
    // narration_discipline is retired (2026-09-10): its old fail row is
    // ignored, so it never lands on the weakness side.
    expect(plan.weaknesses).toEqual(['gst_classification', 'tds_classification']);
    expect(plan.strengths).toEqual(['bill_by_bill_referencing', 'sales_voucher_basics']);
  });

  it('a later pass clears an earlier fail from the weakness side', () => {
    const attempts = [
      attempt('tds_classification', 'fail', '2026-08-01'),
      attempt('tds_classification', 'pass', '2026-08-02'),
    ];
    const plan = selectBatchConcepts(target('gst_classification'), attempts, new Map());
    expect(plan.weaknesses).toEqual(['gst_classification']);
  });

  it('caps both sides at 3 and never repeats a concept across sides', () => {
    const attempts = [
      attempt('tds_classification', 'fail', '2026-08-01'),
      attempt('narration_discipline', 'fail', '2026-08-01'),
      attempt('payment_voucher_basics', 'fail', '2026-08-01'),
      attempt('receipt_voucher_basics', 'fail', '2026-08-01'),
    ];
    const masteryMap = new Map([
      mastery('sales_voucher_basics', { status: 'mastered' }),
      mastery('purchase_voucher_basics', { status: 'mastered' }),
      mastery('journal_voucher_basics', { status: 'mastered' }),
      mastery('contra_voucher_basics', { status: 'mastered' }),
      // Also mastered-looking but already a weakness by latest fail: must not
      // appear as a strength.
      mastery('tds_classification', { consecutive_clean_count: 2 }),
    ]);
    const plan = selectBatchConcepts(target('gst_classification'), attempts, masteryMap);
    expect(plan.weaknesses).toHaveLength(3);
    expect(plan.strengths).toHaveLength(3);
    expect(plan.strengths).not.toContain('tds_classification');
    const overlap = plan.strengths.filter((tag) => plan.weaknesses.includes(tag));
    expect(overlap).toEqual([]);
  });

  it('excludes escalation-active concepts from strengths', () => {
    const masteryMap = new Map([
      mastery('sales_voucher_basics', { status: 'mastered', escalation_active: true }),
    ]);
    const plan = selectBatchConcepts(target('gst_classification'), [], masteryMap);
    expect(plan.strengths).toEqual([]);
  });
});

describe('one new rulebook topic every month (2026-09-11)', () => {
  const basics = new Map([
    mastery('sales_voucher_basics', { status: 'mastered' }),
    mastery('purchase_voucher_basics', { status: 'mastered' }),
    mastery('trial_balance_tie_out', { escalation_active: true }),
  ]);

  it('adds the first never-attempted rulebook concept even while an escalation holds the target', () => {
    const plan = selectBatchConcepts(target('trial_balance_tie_out', true), [attempt('trial_balance_tie_out', 'fail', '2026-09-01')], basics);
    expect(plan.weaknesses).toEqual(['trial_balance_tie_out', 'customer_advance']);
  });

  it('moves to the next rulebook concept once the first has been attempted, and takes the last weakness slot when full', () => {
    const attempts = [
      attempt('trial_balance_tie_out', 'fail', '2026-09-01'),
      attempt('journal_voucher_basics', 'fail', '2026-09-01'),
      attempt('bill_by_bill_referencing', 'fail', '2026-09-01'),
      attempt('customer_advance', 'pass', '2026-09-02'),
    ];
    const masteryMap = new Map([...basics, mastery('customer_advance', { consecutive_clean_count: 1 })]);
    const plan = selectBatchConcepts(target('trial_balance_tie_out', true), attempts, masteryMap);
    expect(plan.weaknesses).toEqual(['trial_balance_tie_out', 'bill_by_bill_referencing', 'supplier_advance']);
  });

  it('waits until the learner has two mastered concepts', () => {
    const plan = selectBatchConcepts(target('gst_classification'), [], new Map([mastery('sales_voucher_basics', { status: 'mastered' })]));
    expect(plan.weaknesses).toEqual(['gst_classification']);
  });
});
