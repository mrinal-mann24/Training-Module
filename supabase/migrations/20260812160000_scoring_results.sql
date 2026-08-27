-- Unit 6: scoring_results table. Written only by the service-role client (the
-- scoring pipeline runs server-side, from a Server Action) — no insert/update
-- policy for authenticated, same pattern as exercises.answer_key in Unit 4.
-- error_codes is internal-only and must never be selected by any client-facing
-- query (see lib/db/queries/scoring-results.ts), even though RLS would
-- technically allow the learner to read their own row's full contents.

create table scoring_results (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions (id) on delete cascade,
  exercise_id uuid not null references exercises (id) on delete cascade,
  learner_id uuid not null references auth.users (id) on delete cascade,
  weighted_score numeric not null,
  tb_tie_out boolean not null,
  error_codes jsonb not null,
  overall_result text not null check (overall_result in ('pass', 'partial', 'fail')),
  feedback_text jsonb not null,
  created_at timestamptz not null default now()
);

alter table scoring_results enable row level security;

create policy "scoring_results_select_own"
  on scoring_results for select
  to authenticated
  using (auth.uid() = learner_id);
