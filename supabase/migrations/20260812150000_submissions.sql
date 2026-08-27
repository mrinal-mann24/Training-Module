-- Unit 5: submissions table + private Storage bucket for Detailed Day Book / Trial Balance XML uploads

create table submissions (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references auth.users (id) on delete cascade,
  exercise_id uuid not null references exercises (id) on delete cascade,
  daybook_path text not null,
  trialbalance_path text not null,
  status text not null check (status in ('validating', 'valid', 'invalid', 'awaiting_scoring')),
  validity_errors jsonb,
  created_at timestamptz not null default now()
);

alter table submissions enable row level security;

create policy "submissions_select_own"
  on submissions for select
  to authenticated
  using (auth.uid() = learner_id);

create policy "submissions_insert_own"
  on submissions for insert
  to authenticated
  with check (auth.uid() = learner_id);

-- Private bucket. Path convention: submissions/{learner_id}/{submission_id}/daybook.xml
-- and .../trialbalance.xml — enforced by the policies below via storage.foldername.
insert into storage.buckets (id, name, public)
values ('submissions', 'submissions', false);

create policy "submissions_storage_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'submissions'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "submissions_storage_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'submissions'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
