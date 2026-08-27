-- Unit 7: submissions.status moves from the Unit 5 set
-- ('validating' | 'valid' | 'invalid' | 'awaiting_scoring') to the fuller set
-- the durable job pipeline needs ('validating' | 'invalid' | 'scoring' | 'scored').
-- 'valid' was never actually written by any code path (the gate wrote straight
-- to 'awaiting_scoring' on success), and 'awaiting_scoring' is superseded by
-- the more granular 'scoring'/'scored' pair so the client can distinguish
-- "gate passed, scoring not started yet" from "scoring in progress" — both of
-- which render the same ai-thinking indicator, but the Inngest function needs
-- the finer-grained states to update status once per step.

alter table submissions
  drop constraint submissions_status_check;

alter table submissions
  add constraint submissions_status_check
  check (status in ('validating', 'invalid', 'scoring', 'scored'));

-- A submission is scored at most once. The Inngest job's scoring step relies
-- on this constraint plus an upsert (see lib/db/queries/scoring-results.ts)
-- so a step retry after a partial failure (e.g. the row insert succeeds but
-- the function crashes before the status update) can't create a duplicate
-- scoring_results row for the same submission.
alter table scoring_results
  add constraint scoring_results_submission_id_key unique (submission_id);

-- Enables Supabase Realtime Postgres Changes for these tables. The chat UI
-- subscribes to submissions/scoring_results row changes instead of polling;
-- existing RLS select policies (auth.uid() = learner_id on both tables) are
-- enforced per-subscriber automatically once a table is in this publication —
-- no separate realtime-specific policy is needed.
alter publication supabase_realtime add table submissions;
alter publication supabase_realtime add table scoring_results;
