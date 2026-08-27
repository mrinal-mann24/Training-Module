-- Unit 4: walkthrough completion flag + exercises table (diagnostic exercise storage)

alter table learner_profile
  add column walkthrough_completed_at timestamptz;

create table exercises (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('diagnostic')),
  scenario jsonb not null,
  answer_key jsonb not null,
  variant text not null check (variant in ('A', 'B')),
  created_at timestamptz not null default now()
);

alter table exercises enable row level security;

create policy "exercises_select_own"
  on exercises for select
  to authenticated
  using (auth.uid() = learner_id);
