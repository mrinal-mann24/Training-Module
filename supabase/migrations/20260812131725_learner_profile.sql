-- Unit 3: learner_profile table (license mode + Books Begin Date onboarding)

create table learner_profile (
  id uuid primary key references auth.users (id) on delete cascade,
  license_mode text not null check (license_mode in ('licensed', 'educational')),
  books_begin_date date not null,
  onboarded_at timestamptz,
  created_at timestamptz not null default now()
);

alter table learner_profile enable row level security;

create policy "learner_profile_select_own"
  on learner_profile for select
  to authenticated
  using (auth.uid() = id);

create policy "learner_profile_insert_own"
  on learner_profile for insert
  to authenticated
  with check (auth.uid() = id);

create policy "learner_profile_update_own"
  on learner_profile for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);
