import { masteryStreakTargetFor, type ConceptTag } from '@/lib/schemas/exercise';
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

// A concept is "mastered" after masteryStreakTargetFor(tag) consecutive
// clean passes: three by default, one for the once-only tier (2026-09-10).

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

// One exercise's verdict on one concept, after its correction rounds are
// folded together (2026-09-17). The fields of the LATEST round's row, plus:
//   - firstAttemptedAt: when the learner first attempted this exercise on
//     this concept. Effective attempts are sequenced by it, so a batch keeps
//     its place in the timeline even if a late correction round lands after
//     the next batch was handed out.
//   - corrected: an earlier round of this exercise failed the concept, so the
//     latest round's result was reached only through the correction loop.
export type EffectiveConceptAttempt = ConceptAttempt & {
  firstAttemptedAt: string;
  corrected: boolean;
};

function byCreatedAtThenId(a: ConceptAttempt, b: ConceptAttempt): number {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

// Folds correction rounds into one attempt per (concept, exercise)
// (2026-09-17). Every round appends a full set of concept_attempts rows
// (architecture.md, "Every round appends its own attempt rows"), and those
// raw rows stay untouched as the audit trail. But the streak, escalation and
// reinforcement rules count EXERCISES a learner has done, not uploads: before
// this, one batch re-submitted four times read as a four-pass streak and
// mastered the concept, and three failing rounds of one batch escalated it.
//
// The latest round (by created_at) wins, result AND hint_rungs_used: help
// pushed during the correction rounds was genuinely spent on that exercise,
// and the per-exercise help count is cumulative, so the latest row carries it.
// Rows are grouped by exercise_id alone, so legacy rows with a null
// submission_id collapse the same way.
export function collapseCorrectionRounds(attempts: ConceptAttempt[]): EffectiveConceptAttempt[] {
  const rounds = new Map<string, ConceptAttempt[]>();
  for (const attempt of attempts) {
    const key = `${attempt.concept_tag}|${attempt.exercise_id}`;
    const group = rounds.get(key);
    if (group) {
      group.push(attempt);
    } else {
      rounds.set(key, [attempt]);
    }
  }

  const effective: EffectiveConceptAttempt[] = [];
  for (const group of rounds.values()) {
    const ordered = [...group].sort(byCreatedAtThenId);
    const latest = ordered[ordered.length - 1];
    effective.push({
      ...latest,
      firstAttemptedAt: ordered[0].created_at,
      corrected: ordered.slice(0, -1).some((round) => round.result === 'fail'),
    });
  }

  return effective.sort(
    (a, b) => a.firstAttemptedAt.localeCompare(b.firstAttemptedAt) || byCreatedAtThenId(a, b),
  );
}

// Whether an exercise counts as "clean" for the mastery streak: it passed,
// hint usage on it didn't exceed the threshold, and it passed without the
// correction loop.
//
// A pass reached only after a correction round is NOT clean, and like any
// other non-clean pass it breaks the streak rather than sitting neutral
// (decision 2026-09-17). Why:
//   - Mastery is "consecutive clean passes", i.e. getting it right on your
//     own, first time, repeatedly. A first-round failure is evidence against
//     that, and before correction rounds existed that same batch was simply a
//     fail and reset the streak. A neutral rule would make the correction
//     loop an easier road to mastery than never having had one: clean,
//     corrected, clean, corrected, clean would master a 3-streak concept
//     with two first-try failures in it.
//   - It matches isCleanPass's existing treatment of a help-heavy pass,
//     which resets the streak too, not a neutral skip.
// It is NOT a failure for escalation or reinforcement, though: the learner
// did fix it, so those windows read the latest round's pass. Escalation is
// for concepts the learner cannot get right, and this one they could.
function isCleanPass(attempt: EffectiveConceptAttempt): boolean {
  return attempt.result === 'pass' && !attempt.corrected && attempt.hint_rungs_used < CLEAN_HELP_STEP_THRESHOLD;
}

function effectiveAttemptsForConcept(attempts: ConceptAttempt[], conceptTag: ConceptTag): EffectiveConceptAttempt[] {
  return collapseCorrectionRounds(attempts.filter((attempt) => attempt.concept_tag === conceptTag));
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
// the same attempts always produces the same patch. Every window below counts
// one attempt per exercise, never one per correction round (2026-09-17, see
// collapseCorrectionRounds).
export function recomputeMastery(input: MasteryRecomputeInput): StatePatch {
  const { attempts, currentMastery } = input;

  const conceptMasteryDeltas: StatePatch['concept_mastery_deltas'] = [];
  const escalationChanges: StatePatch['escalation_changes'] = [];

  for (const conceptTag of computeConceptTags(attempts, currentMastery)) {
    const conceptAttempts = effectiveAttemptsForConcept(attempts, conceptTag);

    if (conceptAttempts.length === 0) {
      continue;
    }

    const latest = conceptAttempts[conceptAttempts.length - 1];

    // Consecutive clean-pass streak, counted back from the most recent
    // exercise — any fail, hint-heavy pass or pass-after-correction resets it
    // to 0.
    let consecutiveCleanCount = 0;
    for (let i = conceptAttempts.length - 1; i >= 0; i--) {
      if (isCleanPass(conceptAttempts[i])) {
        consecutiveCleanCount++;
      } else {
        break;
      }
    }

    const newStatus = consecutiveCleanCount >= masteryStreakTargetFor(conceptTag) ? 'mastered' : 'developing';

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

// 2 of the last 3 exercises on a concept failed -> the next exercise
// targeting it drops one difficulty level and re-targets directly. One
// attempt per exercise, latest round wins (2026-09-17): two failing
// correction rounds of a single batch are one failed batch, not two.
export function checkReinforcement(attempts: ConceptAttempt[], conceptTag: ConceptTag): ReinforcementCheck {
  const conceptAttempts = effectiveAttemptsForConcept(attempts, conceptTag);

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

  // A concept counts as a candidate once it isn't mastered, OR it IS
  // mastered but still escalation_active. The latter happens when a
  // once-only concept (masteryStreakTarget 1, e.g. rcm_and_late_fee) passes
  // on its very next attempt after failing enough times to escalate: the
  // single clean pass flips status to 'mastered' while the same failures
  // are still inside the escalation lookback window. Excluding it here (as
  // the old `status !== 'mastered'` filter alone did) made it invisible to
  // every path that could ever target it again — no reinforcement match, no
  // escalation match, no fallback — so escalation_active could never clear
  // and module advancement (which requires mastered && !escalation_active
  // on every concept) stalled permanently with no learner-facing signal.
  const eligible = candidates.filter((candidate) => candidate.status !== 'mastered' || candidate.escalationActive);
  if (eligible.length === 0) {
    return null;
  }

  const reinforcementTarget = eligible.find((candidate) => candidate.reinforcementActive);
  if (reinforcementTarget) {
    return {
      conceptTag: reinforcementTarget.conceptTag,
      reason: 'reinforcement',
      reinforcementActive: true,
      escalationActive: reinforcementTarget.escalationActive,
    };
  }

  const escalationTarget = eligible.find((candidate) => candidate.escalationActive);
  if (escalationTarget) {
    return {
      conceptTag: escalationTarget.conceptTag,
      reason: 'escalation',
      reinforcementActive: false,
      escalationActive: true,
    };
  }

  // Lowest-status concept not yet mastered: not_started before developing,
  // so a learner sees breadth before depth on any one concept. Anything
  // mastered+escalated was already returned above via escalationTarget, so
  // only genuinely un-mastered concepts reach this fallback.
  const notMastered = eligible.filter((candidate) => candidate.status !== 'mastered');
  if (notMastered.length === 0) {
    return null;
  }
  const STATUS_RANK: Record<string, number> = { not_started: 0, developing: 1 };
  const lowest = [...notMastered].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])[0];

  return {
    conceptTag: lowest.conceptTag,
    reason: 'not_started_or_developing',
    reinforcementActive: false,
    escalationActive: lowest.escalationActive,
  };
}
