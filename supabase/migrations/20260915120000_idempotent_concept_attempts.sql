-- Audit fix (2026-09-15, finding #3): concept_attempts had no uniqueness
-- guard, so an Inngest step retry after insertConceptAttempts succeeded but
-- before the step completed (crash, timeout on the next call) would
-- duplicate the exercise's attempt rows, silently inflating the
-- consecutive-clean-streak count and shifting the escalation lookback
-- window. Every other write in the scoring pipeline was already made
-- idempotent for exactly this reason (scoring_results upserts on
-- submission_id, concept_mastery upserts on (learner_id, concept_tag)) —
-- this table was missed.
--
-- concept_results (lib/tutor/score-submission.ts computeConceptResults) is
-- already a per-concept-tag rollup across all of an exercise's tagged
-- transactions, so a legitimate insertConceptAttempts call never contains
-- the same (learner_id, exercise_id, concept_tag) twice on its own — the
-- constraint below only ever rejects a genuine duplicate retry, never a
-- normal multi-concept batch.

alter table concept_attempts
  add constraint concept_attempts_learner_exercise_concept_unique
  unique (learner_id, exercise_id, concept_tag);
