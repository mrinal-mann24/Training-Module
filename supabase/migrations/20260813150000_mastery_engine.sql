-- Unit 9: mastery engine + adaptive exercise generation.
--
-- exercises.kind gains 'adaptive' (generated targeting a weak concept, not
-- the fixed diagnostic template) alongside the existing 'diagnostic'.
--
-- concept_attempts: append-only raw history, never mutated or deleted by app
-- code — everything else (concept_mastery) is derived from this log.
--
-- concept_mastery: materialized summary, one row per learner per concept.
-- Written only by the recompute path in lib/tutor/mastery.ts (invoked from
-- the mastery recompute step in lib/jobs/run-scoring.ts) — see
-- architecture.md invariant 5. No insert/update policy for authenticated:
-- all writes go through the service-role client, same pattern as
-- exercises.answer_key and scoring_results.
--
-- company_ledger_registry / company_transaction_log: the accumulated record
-- of what's already been posted in the learner's single persistent Tally
-- company (see context/specs/09-mastery-engine-adaptive-generation.md's
-- confirmed design constraint), so exercise generation never invents a
-- colliding ledger/party name or contradicts an existing opening balance.
-- Also written only by the service-role client — the generation pathway is
-- server-side, learners never write these directly.

alter table exercises
  drop constraint exercises_kind_check,
  add constraint exercises_kind_check check (kind in ('diagnostic', 'adaptive'));

create table concept_attempts (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references auth.users (id) on delete cascade,
  exercise_id uuid not null references exercises (id) on delete cascade,
  concept_tag text not null,
  result text not null check (result in ('pass', 'fail')),
  hint_rungs_used integer not null default 0,
  created_at timestamptz not null default now()
);

alter table concept_attempts enable row level security;

create policy "concept_attempts_select_own"
  on concept_attempts for select
  to authenticated
  using (auth.uid() = learner_id);

create table concept_mastery (
  learner_id uuid not null references auth.users (id) on delete cascade,
  concept_tag text not null,
  status text not null check (status in ('not_started', 'developing', 'mastered')) default 'not_started',
  consecutive_clean_count integer not null default 0,
  last_attempt_result text check (last_attempt_result in ('pass', 'fail')),
  escalation_active boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (learner_id, concept_tag)
);

alter table concept_mastery enable row level security;

create policy "concept_mastery_select_own"
  on concept_mastery for select
  to authenticated
  using (auth.uid() = learner_id);

create table company_ledger_registry (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references auth.users (id) on delete cascade,
  ledger_name text not null,
  ledger_type text not null,
  first_used_exercise_id uuid not null references exercises (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (learner_id, ledger_name)
);

alter table company_ledger_registry enable row level security;

create policy "company_ledger_registry_select_own"
  on company_ledger_registry for select
  to authenticated
  using (auth.uid() = learner_id);

create table company_transaction_log (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references auth.users (id) on delete cascade,
  exercise_id uuid not null references exercises (id) on delete cascade,
  voucher_summary jsonb not null,
  created_at timestamptz not null default now()
);

alter table company_transaction_log enable row level security;

create policy "company_transaction_log_select_own"
  on company_transaction_log for select
  to authenticated
  using (auth.uid() = learner_id);
