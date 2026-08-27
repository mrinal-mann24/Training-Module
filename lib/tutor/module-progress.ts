import { CONCEPT_TO_MODULE, type ConceptTag } from '@/lib/schemas/exercise';
import type { ConceptMastery } from '@/lib/db/queries/mastery';
import type { ModuleProgress } from '@/lib/db/queries/module-progress';

// Pure function only — no DB write. The caller (run-scoring.ts's mastery
// recompute step) is the only place module_progress is written, via
// upsertModuleProgress — same invariant discipline as concept_mastery
// (architecture.md invariant 5).
//
// ASSUMPTION (flagged per ai-workflow-rules.md rule 14, confirmed with the
// user before implementing per this unit's spec's own flagged assumption):
// a learner advances to the next module once every concept tagged to their
// current module (CONCEPT_TO_MODULE) has reached concept_mastery.status ===
// 'mastered', with no active escalation on any of those concepts. Advancing
// resets current_level back to 0 (a fresh module starts at the base level).
export function deriveNextModuleProgress(
  current: ModuleProgress | null,
  masteryMap: Map<ConceptTag, ConceptMastery>,
): { currentModule: number; currentLevel: number } {
  const currentModule = current?.current_module ?? 1;
  const currentLevel = current?.current_level ?? 0;

  const conceptsInCurrentModule = (Object.keys(CONCEPT_TO_MODULE) as ConceptTag[]).filter(
    (tag) => CONCEPT_TO_MODULE[tag] === currentModule,
  );

  // No concepts tagged to this module number (past the last defined module,
  // or a gap) — nothing left to evaluate, stay put.
  if (conceptsInCurrentModule.length === 0) {
    return { currentModule, currentLevel };
  }

  const everyConceptMasteredWithNoEscalation = conceptsInCurrentModule.every((tag) => {
    const mastery = masteryMap.get(tag);
    return mastery?.status === 'mastered' && !mastery.escalation_active;
  });

  if (!everyConceptMasteredWithNoEscalation) {
    return { currentModule, currentLevel };
  }

  return { currentModule: currentModule + 1, currentLevel: 0 };
}
