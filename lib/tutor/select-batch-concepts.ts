import type { ConceptTag } from '@/lib/schemas/exercise';
import type { ConceptAttempt, ConceptMastery } from '@/lib/db/queries/mastery';
import type { WeakConceptTarget } from '@/lib/tutor/mastery';

// Phase 2 (spec 14): a batch is composed 50/50 — roughly half its
// transactions INCREASE complexity on concepts the learner has shown strength
// in, half DIG DEEPER into concepts they got wrong. This selector produces
// the two concept lists that composition is built from. Pure and
// deterministic: same inputs, same lists, alphabetical ordering inside each
// side so generation prompts are reproducible.
//
// Caps keep the batch coherent rather than a survey: at most 3 concepts per
// side (a 10-12 transaction batch across more than ~6 concepts stops
// teaching anything in depth).
const MAX_CONCEPTS_PER_SIDE = 3;

export type BatchConceptPlan = {
  strengths: ConceptTag[];
  weaknesses: ConceptTag[];
};

export function selectBatchConcepts(
  target: WeakConceptTarget,
  attempts: ConceptAttempt[],
  masteryMap: Map<ConceptTag, ConceptMastery>,
): BatchConceptPlan {
  // Latest attempt result per concept (attempts arrive oldest-first from the
  // query; walking forward leaves the newest in the map).
  const latestResult = new Map<ConceptTag, 'pass' | 'fail'>();
  for (const attempt of attempts) {
    latestResult.set(attempt.concept_tag, attempt.result);
  }

  // Weaknesses first (the primary target always leads), so a concept can
  // never appear on both sides.
  const weaknessSet = new Set<ConceptTag>([target.conceptTag]);
  const weaknessCandidates = [...latestResult.entries()]
    .filter(([, result]) => result === 'fail')
    .map(([tag]) => tag)
    .filter((tag) => tag !== target.conceptTag)
    .sort();
  for (const tag of weaknessCandidates) {
    if (weaknessSet.size >= MAX_CONCEPTS_PER_SIDE) {
      break;
    }
    weaknessSet.add(tag);
  }

  const strengths = [...masteryMap.values()]
    .filter(
      (mastery) =>
        !weaknessSet.has(mastery.concept_tag) &&
        !mastery.escalation_active &&
        (mastery.status === 'mastered' || mastery.consecutive_clean_count >= 2),
    )
    .map((mastery) => mastery.concept_tag)
    .sort()
    .slice(0, MAX_CONCEPTS_PER_SIDE);

  return { strengths, weaknesses: [...weaknessSet] };
}
