import {
  ACTIVE_CONCEPT_TAGS,
  MAJOR_MODULES,
  isRetiredConcept,
  type ConceptTag,
  type MajorModule,
} from '@/lib/schemas/exercise';
import type { ConceptMasteryStatus } from '@/lib/schemas/state-patch';

// Pure functions only, no DB and no LLM: everything here is derived from the
// mastery map the caller already loaded. The five learner-facing modules are
// a view over concept_mastery, never a second source of truth, so nothing in
// this file writes anything (architecture.md invariant 5).

// Only the field these helpers read, so a test can pass a plain object and a
// caller can pass the full ConceptMastery row unchanged.
export type MasteryStatusLike = { status: ConceptMasteryStatus };
export type MasteryLookup = ReadonlyMap<ConceptTag, MasteryStatusLike>;

function isMastered(masteryMap: MasteryLookup, tag: ConceptTag): boolean {
  return masteryMap.get(tag)?.status === 'mastered';
}

// A module's concepts minus anything retired, so a module can never be stuck
// one concept short of complete because of a tag nothing tests any more.
export function activeConceptsOf(majorModule: MajorModule): ConceptTag[] {
  return majorModule.concepts.filter((tag) => !isRetiredConcept(tag));
}

// `majorModule`, not `module`: the Next lint rule forbids binding the name
// `module`, and a field called that pulls every destructuring caller into the
// same error.
export type MajorModuleProgress = {
  majorModule: MajorModule;
  concepts: { tag: ConceptTag; status: ConceptMasteryStatus }[];
  masteredCount: number;
  totalCount: number;
  complete: boolean;
};

// Per-module breakdown, in curriculum order. This is what /progress renders.
export function majorModuleProgress(masteryMap: MasteryLookup): MajorModuleProgress[] {
  return MAJOR_MODULES.map((majorModule) => {
    const tags = activeConceptsOf(majorModule);
    const concepts = tags.map((tag) => ({
      tag,
      status: masteryMap.get(tag)?.status ?? ('not_started' as const),
    }));
    const masteredCount = concepts.filter((concept) => concept.status === 'mastered').length;
    return {
      majorModule,
      concepts,
      masteredCount,
      totalCount: tags.length,
      complete: tags.length > 0 && masteredCount === tags.length,
    };
  });
}

export type OverallProgress = {
  masteredCount: number;
  totalCount: number;
  // 0-100, rounded. This IS shown to the learner, and is deliberately not the
  // same kind of number as the batch score that was removed on 2026-09-16: it
  // measures how far through the material they are, not how well they did.
  percent: number;
};

// The dashboard bar: mastered concepts out of every concept still taught.
export function overallProgress(masteryMap: MasteryLookup): OverallProgress {
  const totalCount = ACTIVE_CONCEPT_TAGS.length;
  const masteredCount = ACTIVE_CONCEPT_TAGS.filter((tag) => isMastered(masteryMap, tag)).length;
  return {
    masteredCount,
    totalCount,
    percent: totalCount === 0 ? 0 : Math.round((masteredCount / totalCount) * 100),
  };
}

// The module the learner is working through: the first, in curriculum order,
// that still has an un-mastered concept. Once everything is mastered it stays
// on the last module rather than returning null, so the label never empties
// out on a learner who has finished.
export function currentMajorModule(masteryMap: MasteryLookup): MajorModule {
  const unfinished = majorModuleProgress(masteryMap).find((entry) => !entry.complete);
  return unfinished?.majorModule ?? MAJOR_MODULES[MAJOR_MODULES.length - 1];
}
