import { describe, expect, it } from 'vitest';
import { CLEAN_HELP_STEP_THRESHOLD } from '@/lib/tutor/mastery';
import { hintDepthForConcept, type HintDepthByConcept } from './hint-requests';

// Why this matters (2026-09-16): isCleanPass denies the mastery streak to any
// pass with 3 or more help requests behind it. Help depth used to be counted
// per EXERCISE and charged to every concept in the batch. That was survivable
// while help was rare and learner-initiated, but the correction loop pushes a
// hint on every failing batch, so per-exercise counting would deny the streak
// to everything and stall mastery, module advancement and the dashboard bar
// permanently.
describe('hintDepthForConcept', () => {
  it('charges a concept only for the help given on it', () => {
    const depth: HintDepthByConcept = {
      perConcept: { gst_classification: 3, sales_voucher_basics: 1 },
      exerciseWide: 0,
    };

    expect(hintDepthForConcept(depth, 'gst_classification')).toBe(3);
    expect(hintDepthForConcept(depth, 'sales_voucher_basics')).toBe(1);
    expect(hintDepthForConcept(depth, 'tds_classification')).toBe(0);
  });

  // The manual help button says nothing about what the learner is stuck on,
  // and neither do rows written before the concept_tag column existed, so
  // both keep counting against every concept exactly as all help used to.
  it('charges every concept for exercise-level help', () => {
    const depth: HintDepthByConcept = { perConcept: { gst_classification: 1 }, exerciseWide: 2 };

    expect(hintDepthForConcept(depth, 'gst_classification')).toBe(3);
    expect(hintDepthForConcept(depth, 'sales_voucher_basics')).toBe(2);
  });

  it('is zero when no help was given at all', () => {
    expect(hintDepthForConcept({ perConcept: {}, exerciseWide: 0 }, 'gst_classification')).toBe(0);
  });

  // The concrete regression: three pushed hints on ONE concept must not cost
  // the other concepts in that batch their clean pass.
  it('leaves a clean concept clean when another concept in the batch needed all three steps', () => {
    const depth: HintDepthByConcept = { perConcept: { gst_classification: CLEAN_HELP_STEP_THRESHOLD }, exerciseWide: 0 };

    expect(hintDepthForConcept(depth, 'gst_classification')).toBeGreaterThanOrEqual(CLEAN_HELP_STEP_THRESHOLD);
    expect(hintDepthForConcept(depth, 'sales_voucher_basics')).toBeLessThan(CLEAN_HELP_STEP_THRESHOLD);
  });
});
