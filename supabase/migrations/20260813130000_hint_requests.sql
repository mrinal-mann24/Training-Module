-- Unit 8: hint_requests table. Keyed by exercise_id + learner_id, not
-- submission_id — a learner can ask for a hint while still working in Tally,
-- before ever uploading a submission (confirmed against the spec's UX note).
-- hint_content is the composed hint text only; the LLM call that produces it
-- is grounded in the exercise's answer_key server-side, but the raw
-- answer_key structure itself is never written here or returned to the
-- client — see lib/tutor/generate-hint.ts.

create table hint_requests (
  id uuid primary key default gen_random_uuid(),
  exercise_id uuid not null references exercises (id) on delete cascade,
  learner_id uuid not null references auth.users (id) on delete cascade,
  rung smallint not null check (rung between 1 and 5),
  hint_content jsonb not null,
  created_at timestamptz not null default now()
);

alter table hint_requests enable row level security;

create policy "hint_requests_select_own"
  on hint_requests for select
  to authenticated
  using (auth.uid() = learner_id);

create policy "hint_requests_insert_own"
  on hint_requests for insert
  to authenticated
  with check (auth.uid() = learner_id);
