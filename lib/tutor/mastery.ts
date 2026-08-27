import type { ConceptTag } from '@/lib/schemas/exercise';
import type { StatePatch } from '@/lib/schemas/state-patch';
import type { ConceptAttempt, ConceptMastery } from '@/lib/db/queries/mastery';

// Pure functions only — no LLM call, no direct DB write. The recompute
// step's caller (run-scoring.ts) is the only place concept_mastery is
// written, via applyStatePatch (architecture.md invariant 5).

// Phase 3 (spec 15): step 3 of the help flow is the full answer, so a pass
// that reached it doesn't count toward the mastery streak — the concept
// stays in reinforcement until the learner passes without being handed the
// answer. hint_rungs_used is the per-exercise help-request COUNT (each
// request advances one step, capped at step 3), so legacy 5-rung rows with
// 3+ requests read as having reached step 3 — exactly the spec's "rung 4-5
// read as step 3 for depth signals".
// Named constant per the spec's explicit "not a magic number" instruction.
export const CLEAN_HELP_STEP_THRESHOLD = 3;

// A concept is "mastered" after this many consecutive clean passes.
const MASTERY_STREAK_TARGET = 3;

// Window size for the reinforcement rule ("2 of the last 3 attempts failed").
const REINFORCEMENT_WINDOW = 3;
const REINFORCEMENT_FAILURE_THRESHOLD = 2;

// Escalation activates once a concept has this many total recent failures —
// not necessarily consecutive, matching project-overview.md's "3 failures"
// framing for escalation as distinct from reinforcement's 2-of-3 window.
const ESCALATION_FAILURE_THRESHOLD = 3;
// How far back "recent" looks for escalation, so a learner who failed 3
// times months ago (long since mastered) doesn't stay escalated forever.
const ESCALATION_LOOKBACK_WINDOW = 5;

export type MasteryRecomputeInput = {
  attempts: ConceptAttempt[];
  currentMastery: Map<ConceptTag, ConceptMastery>;
};

// Whether an attempt counts as "clean" for the mastery streak: it passed,
// and hint usage on it didn't exceed the threshold.
function isCleanPass(attempt: ConceptAttempt): boolean {
  return attempt.result === 'pass' && attempt.hint_rungs_used < CLEAN_HELP_STEP_THRESHOLD;
}

function computeConceptTags(attempts: ConceptAttempt[], currentMastery: Map<ConceptTag, ConceptMastery>): ConceptTag[] {
  const tags = new Set<ConceptTag>();
  for (const attempt of attempts) {
    tags.add(attempt.concept_tag);
  }
  for (const tag of currentMastery.keys()) {
    tags.add(tag);
  }
  return [...tags];
}

// Recomputes concept_mastery deltas + escalation flags from the full
// concept_attempts history. Deterministic and idempotent: re-running against
// the same attempts always produces the same patch.
export function recomputeMastery(input: MasteryRecomputeInput): StatePatch {
  const { attempts, currentMastery } = input;

  const conceptMasteryDeltas: StatePatch['concept_mastery_deltas'] = [];
  const escalationChanges: StatePatch['escalation_changes'] = [];

  for (const conceptTag of computeConceptTags(attempts, currentMastery)) {
    const conceptAttempts = attempts
      .filter((attempt) => attempt.concept_tag === conceptTag)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    if (conceptAttempts.length === 0) {
      continue;
    }

    const latest = conceptAttempts[conceptAttempts.length - 1];

    // Consecutive clean-pass streak, counted back from the most recent
    // attempt — any fail or hint-heavy pass resets it to 0.
    let consecutiveCleanCount = 0;
    for (let i = conceptAttempts.length - 1; i >= 0; i--) {
      if (isCleanPass(conceptAttempts[i])) {
        consecutiveCleanCount++;
      } else {
        break;
      }
    }

    const newStatus = consecutiveCleanCount >= MASTERY_STREAK_TARGET ? 'mastered' : 'developing';

    conceptMasteryDeltas.push({
      concept_tag: conceptTag,
      new_status: newStatus,
      consecutive_clean_count: consecutiveCleanCount,
      last_attempt_result: latest.result,
    });

    // Escalation: 3 total failures within the recent lookback window, not
    // necessarily consecutive.
    const recentAttempts = conceptAttempts.slice(-ESCALATION_LOOKBACK_WINDOW);
    const recentFailureCount = recentAttempts.filter((attempt) => attempt.result === 'fail').length;
    const escalationActive = recentFailureCount >= ESCALATION_FAILURE_THRESHOLD;

    escalationChanges.push({ concept_tag: conceptTag, escalation_active: escalationActive });
  }

  return {
    concept_mastery_deltas: conceptMasteryDeltas,
    escalation_changes: escalationChanges,
  };
}

export type ReinforcementCheck = {
  reinforcementActive: boolean;
};

// 2 of the last 3 attempts on a concept failed -> the next exercise
// targeting it drops one difficulty level and re-targets directly.
export function checkReinforcement(attempts: ConceptAttempt[], conceptTag: ConceptTag): ReinforcementCheck {
  const conceptAttempts = attempts
    .filter((attempt) => attempt.concept_tag === conceptTag)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const lastThree = conceptAttempts.slice(-REINFORCEMENT_WINDOW);
  const failureCount = lastThree.filter((attempt) => attempt.result === 'fail').length;

  return { reinforcementActive: failureCount >= REINFORCEMENT_FAILURE_THRESHOLD };
}

export type WeakConceptTarget = {
  conceptTag: ConceptTag;
  reason: 'reinforcement' | 'escalation' | 'not_started_or_developing';
  reinforcementActive: boolean;
  escalationActive: boolean;
};

// Picks the concept the next adaptive exercise should target: a
// reinforcement/escalation concept if one is active, otherwise the
// lowest-status concept not yet mastered. All concepts in CONCEPT_TAGS are
// candidates, including ones with no attempts yet ("not_started").
export function selectWeakConcept(
  allConceptTags: readonly ConceptTag[],
  attempts: ConceptAttempt[],
  masteryMap: Map<ConceptTag, ConceptMastery>,
): WeakConceptTarget | null {
  const candidates = allConceptTags.map((conceptTag) => {
    const mastery = masteryMap.get(conceptTag);
    const status = mastery?.status ?? 'not_started';
    const { reinforcementActive } = checkReinforcement(attempts, conceptTag);
    const escalationActive = mastery?.escalation_active ?? false;
    return { conceptTag, status, reinforcementActive, escalationActive };
  });

  const notMastered = candidates.filter((candidate) => candidate.status !== 'mastered');
  if (notMastered.length === 0) {
    return null;
  }

  const reinforcementTarget = notMastered.find((candidate) => candidate.reinforcementActive);
  if (reinforcementTarget) {
    return {
      conceptTag: reinforcementTarget.conceptTag,
      reason: 'reinforcement',
      reinforcementActive: true,
      escalationActive: reinforcementTarget.escalationActive,
    };
  }

  const escalationTarget = notMastered.find((candidate) => candidate.escalationActive);
  if (escalationTarget) {
    return {
      conceptTag: escalationTarget.conceptTag,
      reason: 'escalation',
      reinforcementActive: false,
      escalationActive: true,
    };
  }

  // Lowest-status concept not yet mastered: not_started before developing,
  // so a learner sees breadth before depth on any one concept.
  const STATUS_RANK: Record<string, number> = { not_started: 0, developing: 1 };
  const lowest = [...notMastered].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])[0];

  return {
    conceptTag: lowest.conceptTag,
    reason: 'not_started_or_developing',
    reinforcementActive: false,
    escalationActive: lowest.escalationActive,
  };
}
