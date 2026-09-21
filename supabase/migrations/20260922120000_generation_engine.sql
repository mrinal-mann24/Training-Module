-- Per-learner generation engine (2026-09-22, rebuild Stage 4). 'legacy' is
-- the LLM-authored answer key; 'planned' is the rebuilt path where the
-- model writes only the month's story and code builds every ledger leg,
-- tax figure, allocation and document (lib/tutor/generate-planned-exercise.ts).
-- Flipped per learner by the owner, at that learner's next batch, so the
-- three interns move over one at a time. Learners never write this column
-- (the existing update policy is scoped to their own row; the app never
-- exposes the field).

alter table learner_profile
  add column generation_engine text not null default 'legacy'
    check (generation_engine in ('legacy', 'planned'));
