import { describe, expect, it } from 'vitest';
import {
  ACTIVE_CONCEPT_TAGS,
  MAJOR_MODULES,
  MAJOR_MODULE_BY_CONCEPT,
  RETIRED_CONCEPT_TAGS,
  type ConceptTag,
} from '@/lib/schemas/exercise';
import type { ConceptMasteryStatus } from '@/lib/schemas/state-patch';
import { currentMajorModule, majorModuleProgress, overallProgress, type MasteryLookup } from './major-modules';

function mastery(entries: Partial<Record<ConceptTag, ConceptMasteryStatus>>): MasteryLookup {
  return new Map(Object.entries(entries).map(([tag, status]) => [tag as ConceptTag, { status: status! }]));
}

function allMastered(): MasteryLookup {
  return new Map(ACTIVE_CONCEPT_TAGS.map((tag) => [tag, { status: 'mastered' as const }]));
}

describe('MAJOR_MODULES coverage', () => {
  // The guard that matters: adding a concept tag without placing it would
  // give a learner a concept they can be tested on but never see progress
  // for, and would silently shrink the denominator of the dashboard bar.
  it('places every active concept in exactly one module', () => {
    const placed = MAJOR_MODULES.flatMap((majorModule) => majorModule.concepts);
    expect([...placed].sort()).toEqual([...ACTIVE_CONCEPT_TAGS].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('places no retired concept', () => {
    const placed = new Set<string>(MAJOR_MODULES.flatMap((majorModule) => majorModule.concepts));
    for (const retired of RETIRED_CONCEPT_TAGS) {
      expect(placed.has(retired)).toBe(false);
    }
  });

  it('is five modules with unique ids and titles', () => {
    expect(MAJOR_MODULES).toHaveLength(5);
    expect(new Set(MAJOR_MODULES.map((majorModule) => majorModule.id)).size).toBe(5);
    expect(new Set(MAJOR_MODULES.map((majorModule) => majorModule.title)).size).toBe(5);
  });

  it('reverse-maps each concept back to its module', () => {
    for (const majorModule of MAJOR_MODULES) {
      for (const tag of majorModule.concepts) {
        expect(MAJOR_MODULE_BY_CONCEPT[tag]).toBe(majorModule.id);
      }
    }
  });
});

describe('overallProgress', () => {
  it('is 0 percent for a learner who has mastered nothing', () => {
    expect(overallProgress(new Map())).toEqual({
      masteredCount: 0,
      totalCount: ACTIVE_CONCEPT_TAGS.length,
      percent: 0,
    });
  });

  it('is 100 percent only when every active concept is mastered', () => {
    expect(overallProgress(allMastered()).percent).toBe(100);
  });

  it('counts part-way through and rounds', () => {
    const progress = overallProgress(
      mastery({ sales_voucher_basics: 'mastered', purchase_voucher_basics: 'mastered' }),
    );
    expect(progress.masteredCount).toBe(2);
    expect(progress.percent).toBe(Math.round((2 / ACTIVE_CONCEPT_TAGS.length) * 100));
  });

  it('ignores a retired concept even when an old row still says mastered', () => {
    const withRetired = mastery({ narration_discipline: 'mastered' });
    expect(overallProgress(withRetired).masteredCount).toBe(0);
  });

  it('does not count a developing concept', () => {
    expect(overallProgress(mastery({ sales_voucher_basics: 'developing' })).masteredCount).toBe(0);
  });
});

describe('majorModuleProgress', () => {
  it('reports every module in curriculum order, with all concepts not_started by default', () => {
    const progress = majorModuleProgress(new Map());
    expect(progress.map((entry) => entry.majorModule.id)).toEqual(MAJOR_MODULES.map((majorModule) => majorModule.id));
    expect(progress.every((entry) => entry.masteredCount === 0)).toBe(true);
    expect(progress.every((entry) => entry.concepts.every((concept) => concept.status === 'not_started'))).toBe(true);
  });

  it('marks a module complete only when all of its concepts are mastered', () => {
    const banking = MAJOR_MODULES.find((majorModule) => majorModule.id === 'banking')!;
    const partial = mastery({ [banking.concepts[0]]: 'mastered' });
    expect(majorModuleProgress(partial).find((entry) => entry.majorModule.id === 'banking')!.complete).toBe(false);

    const full = new Map(banking.concepts.map((tag) => [tag, { status: 'mastered' as const }]));
    expect(majorModuleProgress(full).find((entry) => entry.majorModule.id === 'banking')!.complete).toBe(true);
  });

  it('totals match the overall denominator', () => {
    const total = majorModuleProgress(new Map()).reduce((sum, entry) => sum + entry.totalCount, 0);
    expect(total).toBe(ACTIVE_CONCEPT_TAGS.length);
  });
});

describe('currentMajorModule', () => {
  it('starts on the first module', () => {
    expect(currentMajorModule(new Map()).id).toBe(MAJOR_MODULES[0].id);
  });

  it('moves on once a module is fully mastered', () => {
    const first = MAJOR_MODULES[0];
    const finishedFirst = new Map(first.concepts.map((tag) => [tag, { status: 'mastered' as const }]));
    expect(currentMajorModule(finishedFirst).id).toBe(MAJOR_MODULES[1].id);
  });

  it('stays on the last module once everything is mastered rather than emptying out', () => {
    expect(currentMajorModule(allMastered()).id).toBe(MAJOR_MODULES[MAJOR_MODULES.length - 1].id);
  });
});
