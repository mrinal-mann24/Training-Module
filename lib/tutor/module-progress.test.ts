import { describe, expect, it } from 'vitest';
import { deriveNextModuleProgress } from './module-progress';
import { CONCEPT_TO_MODULE, type ConceptTag } from '@/lib/schemas/exercise';
import type { ConceptMastery } from '@/lib/db/queries/mastery';

function mastery(overrides: Partial<ConceptMastery> & { concept_tag: ConceptTag }): ConceptMastery {
  return {
    learner_id: 'learner-1',
    status: 'mastered',
    consecutive_clean_count: 3,
    last_attempt_result: 'pass',
    escalation_active: false,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// CONCEPT_TO_MODULE maps one concept per module in CONCEPT_TAGS order —
// module 1 is whichever concept is first in that vocabulary.
const MODULE_1_CONCEPT = (Object.keys(CONCEPT_TO_MODULE) as ConceptTag[]).find(
  (tag) => CONCEPT_TO_MODULE[tag] === 1,
)!;
const MODULE_2_CONCEPT = (Object.keys(CONCEPT_TO_MODULE) as ConceptTag[]).find(
  (tag) => CONCEPT_TO_MODULE[tag] === 2,
)!;

describe('deriveNextModuleProgress', () => {
  it('advances to the next module and resets the level once every concept in the current module is mastered with no escalation', () => {
    const masteryMap = new Map([[MODULE_1_CONCEPT, mastery({ concept_tag: MODULE_1_CONCEPT, status: 'mastered', escalation_active: false })]]);

    const result = deriveNextModuleProgress({ learner_id: 'learner-1', current_module: 1, current_level: 2, updated_at: '2026-01-01T00:00:00.000Z' }, masteryMap);

    expect(result).toEqual({ currentModule: 2, currentLevel: 0 });
  });

  it('does not advance while a concept in the current module is not yet mastered', () => {
    const masteryMap = new Map([[MODULE_1_CONCEPT, mastery({ concept_tag: MODULE_1_CONCEPT, status: 'developing', escalation_active: false })]]);

    const result = deriveNextModuleProgress({ learner_id: 'learner-1', current_module: 1, current_level: 1, updated_at: '2026-01-01T00:00:00.000Z' }, masteryMap);

    expect(result).toEqual({ currentModule: 1, currentLevel: 1 });
  });

  it('does not advance while escalation is active on a mastered concept in the current module', () => {
    const masteryMap = new Map([[MODULE_1_CONCEPT, mastery({ concept_tag: MODULE_1_CONCEPT, status: 'mastered', escalation_active: true })]]);

    const result = deriveNextModuleProgress({ learner_id: 'learner-1', current_module: 1, current_level: 0, updated_at: '2026-01-01T00:00:00.000Z' }, masteryMap);

    expect(result).toEqual({ currentModule: 1, currentLevel: 0 });
  });

  it('defaults to module 1 / level 0 when there is no existing module_progress row', () => {
    const masteryMap = new Map([[MODULE_1_CONCEPT, mastery({ concept_tag: MODULE_1_CONCEPT, status: 'developing', escalation_active: false })]]);

    const result = deriveNextModuleProgress(null, masteryMap);

    expect(result).toEqual({ currentModule: 1, currentLevel: 0 });
  });

  it('does not advance a module whose concept has no mastery row yet (not_started)', () => {
    const result = deriveNextModuleProgress(
      { learner_id: 'learner-1', current_module: 2, current_level: 0, updated_at: '2026-01-01T00:00:00.000Z' },
      new Map(),
    );

    expect(result).toEqual({ currentModule: 2, currentLevel: 0 });
  });

  it('is unaffected by concepts belonging to a different module', () => {
    const masteryMap = new Map([
      [MODULE_1_CONCEPT, mastery({ concept_tag: MODULE_1_CONCEPT, status: 'mastered', escalation_active: false })],
      [MODULE_2_CONCEPT, mastery({ concept_tag: MODULE_2_CONCEPT, status: 'developing', escalation_active: false })],
    ]);

    const result = deriveNextModuleProgress({ learner_id: 'learner-1', current_module: 1, current_level: 0, updated_at: '2026-01-01T00:00:00.000Z' }, masteryMap);

    expect(result).toEqual({ currentModule: 2, currentLevel: 0 });
  });
});
