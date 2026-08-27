-- Unit 12: progress view + rectification tracking.
--
-- module_progress: one row per learner, current_module/current_level. Written
-- only through lib/tutor/module-progress.ts's advancement check, invoked as
-- an additional step in Unit 09's mastery recompute (lib/jobs/run-scoring.ts)
-- — same invariant discipline as concept_mastery (architecture.md invariant
-- 5): no insert/update policy for authenticated, all writes go through the
-- service-role client.
--
-- Advancement rule (per this unit's spec, confirmed with the user against
-- the module-advancement assumption it flagged): a learner advances to the
-- next module once every concept tagged to their current module has reached
-- concept_mastery.status = 'mastered' with no active escalation. The
-- concept-to-module grouping used to evaluate this is a static constant map
-- (lib/schemas/exercise.ts's CONCEPT_TO_MODULE), not a DB table — 11
-- CONCEPT_TAGS, one concept per module, in CONCEPT_TAGS order, confirmed
-- with the user rather than inventing a thematic grouping.

create table module_progress (
  learner_id uuid primary key references auth.users (id) on delete cascade,
  current_module integer not null default 1,
  current_level integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table module_progress enable row level security;

create policy "module_progress_select_own"
  on module_progress for select
  to authenticated
  using (auth.uid() = learner_id);
