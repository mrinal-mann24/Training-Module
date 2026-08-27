-- Unit 11: multi-part submissions + qualitative scoring + anomaly seeding.
--
-- exercises.kind gains 'explain' (direct-entry Tally posting + a free-text
-- explanation, same answer_key shape as diagnostic/adaptive) and 'review'
-- (no Tally posting at all — a review packet of ledger_review_items is this
-- kind's answer-key equivalent, so answer_key stores an empty entries array
-- for these rows; see lib/schemas/exercise.ts and
-- lib/tutor/generate-review-exercise.ts).
--
-- required_parts on exercises records which submission_parts a submission
-- for this exercise must have before it's "complete" — set at generation
-- time based on kind (direct-entry exercises: daybook_xml + trialbalance_xml,
-- unchanged from Units 05-07; explain: the same two plus explain_text;
-- review: review_text alone).
--
-- submission_parts: one row per part of a multi-part submission. A
-- submissions row groups them by submission_id; lib/db/queries/submission-parts.ts
-- checks "all of exercise.required_parts have a matching row" for
-- completeness. content is jsonb for text parts (explain_text/review_text)
-- or a storage path reference for file parts (daybook_xml/trialbalance_xml)
-- — the file itself still lives in the existing submissions Storage bucket
-- at submissions.daybook_path/trialbalance_path; content here is just
-- {storage_path: ...} for those two part_types, kept structurally consistent
-- with the jsonb column rather than adding two more nullable path columns.
--
-- anomaly_templates: server-only library of seeded ledger anomalies (what
-- makes an entry wrong, and a matching clean-distractor description), never
-- exposed to the client — same handling discipline as exercises.answer_key.
--
-- ledger_review_items: the per-exercise-instance review packet + its
-- server-only answer key (is_anomaly, which anomaly_template if any). RLS
-- select-only via the same exists-subquery-through-exercises pattern Unit 10
-- used for exercise_source_documents, since this table has no learner_id
-- column of its own — no insert/update policy for authenticated, all writes
-- go through the service-role client (generate-review-exercise.ts).

alter table exercises
  drop constraint exercises_kind_check,
  add constraint exercises_kind_check check (kind in ('diagnostic', 'adaptive', 'explain', 'review'));

alter table exercises
  add column required_parts text[] not null default array['daybook_xml', 'trialbalance_xml'];

-- A 'review' exercise's submission has no file parts at all (required_parts
-- is just review_text — no daybook/TB upload), so these two columns can no
-- longer be not-null. submission_parts is the source of truth for what
-- actually arrived; these remain populated for exercises that do require
-- file parts (unchanged from Units 05-07).
alter table submissions
  alter column daybook_path drop not null,
  alter column trialbalance_path drop not null;

-- Qualitative scoring (recall/precision/reasoning_quality/rationale, see
-- lib/schemas/qualitative-scoring.ts) alongside the existing quantitative
-- columns. Nullable because a direct-entry exercise (diagnostic/adaptive)
-- has none. For 'explain' exercises both quantitative and qualitative are
-- populated and combined into overall_result (score-qualitative.ts's
-- combineScoring). For 'review' exercises there is no Tally posting at all,
-- so weighted_score is persisted as 0 and tb_tie_out as true (vacuously —
-- nothing to tie out) purely to satisfy the existing NOT NULL constraints;
-- overall_result for a review exercise is derived from qualitative_score
-- alone. This convention is documented at every write site
-- (lib/db/queries/scoring-results.ts), not just here.
alter table scoring_results
  add column qualitative_score jsonb;

create table submission_parts (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions (id) on delete cascade,
  part_type text not null check (part_type in ('daybook_xml', 'trialbalance_xml', 'explain_text', 'review_text')),
  content jsonb not null,
  received_at timestamptz not null default now(),
  unique (submission_id, part_type)
);

alter table submission_parts enable row level security;

-- Learner-scoped via a join through submissions (this table has no
-- learner_id column of its own) — same exists-subquery pattern as Unit 10's
-- exercise_source_documents policy.
create policy "submission_parts_select_own"
  on submission_parts for select
  to authenticated
  using (
    exists (
      select 1 from submissions
      where submissions.id = submission_parts.submission_id
      and submissions.learner_id = auth.uid()
    )
  );

-- Learners post explain_text/review_text messages themselves (ordinary chat
-- composer, no special upload UI, per the spec) and the file parts are
-- inserted by the authenticated client in the same request that uploads to
-- Storage (matching how submissions itself is inserted by the authenticated
-- client in Unit 05/07's submitFiles) — so unlike exercises.answer_key or
-- scoring_results, this table needs an insert policy for authenticated, not
-- service-role-only.
create policy "submission_parts_insert_own"
  on submission_parts for insert
  to authenticated
  with check (
    exists (
      select 1 from submissions
      where submissions.id = submission_parts.submission_id
      and submissions.learner_id = auth.uid()
    )
  );

-- Enables Realtime status-checklist updates (Unit 07's existing pattern) as
-- parts arrive for an incomplete submission.
alter publication supabase_realtime add table submission_parts;

create table anomaly_templates (
  id uuid primary key default gen_random_uuid(),
  concept_tag text not null,
  anomaly_description text not null,
  clean_distractor_description text not null,
  difficulty_level text not null check (difficulty_level in ('L0', 'L1', 'L2', 'L3', 'L4')),
  created_at timestamptz not null default now()
);

alter table anomaly_templates enable row level security;

-- No policies at all: this is server-only library content, read only by
-- generate-review-exercise.ts via the service-role client, same discipline
-- as exercises.answer_key. Learners never query this table directly, in any
-- form, so there is intentionally no select policy for authenticated.

create table ledger_review_items (
  id uuid primary key default gen_random_uuid(),
  exercise_id uuid not null references exercises (id) on delete cascade,
  source text not null check (source in ('real_transaction', 'generated_distractor')),
  company_transaction_log_id uuid references company_transaction_log (id) on delete set null,
  anomaly_template_id uuid references anomaly_templates (id) on delete set null,
  is_anomaly boolean not null,
  presented_text text not null,
  created_at timestamptz not null default now()
);

alter table ledger_review_items enable row level security;

-- Learner-scoped via a join through exercises (no learner_id column of its
-- own), same pattern as exercise_source_documents. No insert/update policy
-- for authenticated: this is the review exercise's answer-key equivalent
-- (is_anomaly must never be learner-writable), all writes go through the
-- service-role client.
create policy "ledger_review_items_select_own"
  on ledger_review_items for select
  to authenticated
  using (
    exists (
      select 1 from exercises
      where exercises.id = ledger_review_items.exercise_id
      and exercises.learner_id = auth.uid()
    )
  );
