import { isRetiredConcept, RULEBOOK_SECTION_CONCEPT_TAGS, type ConceptTag } from '@/lib/schemas/exercise';
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
const NEW_TOPIC_MASTERY_THRESHOLD = 2;

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
    // Retired concepts (narration, 2026-09-10) still have old attempt rows;
    // they are never a weakness to dig into.
    .filter((tag) => tag !== target.conceptTag && !isRetiredConcept(tag))
    .sort();
  for (const tag of weaknessCandidates) {
    if (weaknessSet.size >= MAX_CONCEPTS_PER_SIDE) {
      break;
    }
    weaknessSet.add(tag);
  }

  // One new rulebook topic every month (owner, 2026-09-11): the first
  // rulebook-section concept the learner has never attempted rides along
  // as a weakness once they hold the basics (two mastered concepts, the
  // documents-mode bar), even while an escalation or reinforcement keeps
  // the primary target — otherwise the advances waited on a Trial Balance
  // escalation for months. It takes the last weakness slot.
  const masteredCount = [...masteryMap.values()].filter((m) => m.status === 'mastered' && !isRetiredConcept(m.concept_tag)).length;
  if (masteredCount >= NEW_TOPIC_MASTERY_THRESHOLD) {
    const nextNewTopic = RULEBOOK_SECTION_CONCEPT_TAGS.find(
      (tag) => tag !== target.conceptTag && !masteryMap.has(tag) && !latestResult.has(tag),
    );
    if (nextNewTopic && !weaknessSet.has(nextNewTopic)) {
      if (weaknessSet.size >= MAX_CONCEPTS_PER_SIDE) {
        weaknessSet.delete([...weaknessSet][weaknessSet.size - 1]);
      }
      weaknessSet.add(nextNewTopic);
    }
  }

  const strengths = [...masteryMap.values()]
    .filter(
      (mastery) =>
        !isRetiredConcept(mastery.concept_tag) &&
        !weaknessSet.has(mastery.concept_tag) &&
        !mastery.escalation_active &&
        (mastery.status === 'mastered' || mastery.consecutive_clean_count >= 2),
    )
    .map((mastery) => mastery.concept_tag)
    .sort()
    .slice(0, MAX_CONCEPTS_PER_SIDE);

  return { strengths, weaknesses: [...weaknessSet] };
}
