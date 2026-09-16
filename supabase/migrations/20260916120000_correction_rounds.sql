-- Correction rounds (2026-09-16): a scored exercise may now accept further
-- submissions, so a learner who got something wrong can fix it in Tally and
-- re-upload while the tutor walks them up the 3-step help ladder.
--
-- Four schema changes, each closing a concrete break the feature would
-- otherwise cause (see the plan's hazard list):
--
-- H1. concept_attempts was unique on (learner_id, exercise_id, concept_tag)
--     and insertConceptAttempts upserts with ignoreDuplicates, so a second
--     scoring of the same exercise wrote ZERO rows — the learner's
--     correction would have been silently discarded and mastery would never
--     have moved. submission_id joins the key so every round appends its own
--     row, while an Inngest step retry (same submissionId) still collapses
--     to a no-op exactly as the 2026-09-15 idempotency fix intended.
--
-- H4. hint_rungs_used is snapshotted per exercise and applied to every
--     concept of the batch, and isCleanPass requires < 3. Once the tutor
--     PUSHES hints instead of waiting to be asked, every concept in a batch
--     with 3 help rows would lose clean-pass credit, so nothing would ever
--     reach 'mastered'. hint_requests.concept_tag lets the depth be counted
--     per concept. Legacy rows and exercise-level help keep a null tag and
--     go on counting against every concept, so existing data behaves as it
--     always did.
--
-- H5. 20260915130000 revoked answer_key/error_codes/qualitative_score but
--     not weighted_score or overall_result, so a learner could read their
--     own raw score straight from the browser. With percentages and
--     pass/fail leaving the UI, the column privileges have to agree.
--
-- Every server-side reader of these columns goes through the service-role
-- client, which a REVOKE scoped to `authenticated` does not affect.

-- Which round of an exercise this submission is: 0 = the first, honest
-- attempt; 1..3 = corrections after help step 1, 2 and 3. Existing rows are
-- all first attempts.
alter table submissions
  add column correction_round integer not null default 0
  check (correction_round >= 0 and correction_round <= 3);

-- One attempt row per concept PER SUBMISSION, not per exercise.
alter table concept_attempts
  add column submission_id uuid references submissions (id) on delete cascade;

-- Backfill: every existing attempt came from the exercise's first scored
-- submission, which scoring_results records.
update concept_attempts ca
set submission_id = (
  select sr.submission_id
  from scoring_results sr
  where sr.exercise_id = ca.exercise_id
    and sr.learner_id = ca.learner_id
  order by sr.created_at asc
  limit 1
)
where ca.submission_id is null;

alter table concept_attempts
  drop constraint concept_attempts_learner_exercise_concept_unique;

alter table concept_attempts
  add constraint concept_attempts_learner_exercise_concept_submission_unique
  unique (learner_id, exercise_id, concept_tag, submission_id);

-- Postgres treats NULLs as distinct in a unique constraint, so any row the
-- backfill could not resolve (a scoring_results row deleted out from under
-- it) would lose its duplicate guard. This partial index keeps the original
-- guarantee for exactly those rows.
create unique index concept_attempts_legacy_no_submission_unique
  on concept_attempts (learner_id, exercise_id, concept_tag)
  where submission_id is null;

-- Which concept a help request was about. Null = exercise-level help, which
-- is every row written before today.
alter table hint_requests
  add column concept_tag text;

update hint_requests
set concept_tag = hint_content ->> 'concept_tag'
where concept_tag is null
  and hint_content ->> 'concept_tag' is not null;

revoke select (weighted_score, overall_result) on scoring_results from authenticated;
