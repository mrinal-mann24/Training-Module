-- Learner issue reports (2026-09-15, user request): a "Report an issue"
-- button in the chat stores what the learner typed plus a snapshot of where
-- they were (latest exercise, its latest submission), so the owner no longer
-- has to ask "which month / which upload" over WhatsApp.
--
-- Write path: the reportIssue Server Action validates, rate-limits and
-- inserts through the service-role client (lib/chat/report-issue.ts). Learners
-- get NO insert/update/delete grant: a direct browser insert would otherwise
-- let a learner skip the rate limit, forge the context columns, or mark their
-- own issue resolved with a fake reply.
--
-- Context columns are plain snapshots with NO foreign keys, on purpose. The
-- owner's reset procedure deletes exercises and submissions, and an issue
-- about that very batch must survive the reset untouched. ON DELETE SET NULL
-- was rejected in review: submissions already cascade from exercises, so one
-- DELETE on exercises would reach the same learner_issues row by two paths,
-- and a reset must never depend on how Postgres orders those actions. With
-- no FK, deletes never touch this table; a dangling id is harmless because
-- exercise_level / exercise_created_at / submission_status still say which
-- batch it was.

create table learner_issues (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references auth.users (id) on delete cascade,
  message text not null check (char_length(btrim(message)) between 1 and 2000),
  exercise_id uuid,
  submission_id uuid,
  exercise_level text,
  exercise_created_at timestamptz,
  submission_status text,
  status text not null default 'open' check (status in ('open', 'resolved')),
  admin_reply text check (admin_reply is null or char_length(admin_reply) <= 4000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- The learner's own list and the rate-limit lookback both read by learner,
-- newest first; the owner's triage query reads open issues newest first.
create index learner_issues_learner_created_idx on learner_issues (learner_id, created_at desc);
create index learner_issues_open_idx on learner_issues (created_at desc) where status = 'open';

alter table learner_issues enable row level security;

create policy "learner_issues_select_own"
  on learner_issues for select
  to authenticated
  using ((select auth.uid()) = learner_id);

-- No insert/update/delete policies on purpose (see header). The explicit
-- revokes are defence in depth over Supabase's default table grants;
-- TRUNCATE in particular is not governed by row-level security at all.
revoke insert, update, delete, truncate on learner_issues from authenticated;
revoke all on learner_issues from anon;

-- The owner resolves issues by hand (table editor or SQL). Setting status is
-- enough: resolved_at is stamped on the way to 'resolved' and cleared if the
-- issue is reopened, so the two columns can never disagree.
create or replace function public.set_learner_issue_resolved_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'resolved' then
    new.resolved_at := coalesce(new.resolved_at, now());
  else
    new.resolved_at := null;
  end if;
  return new;
end;
$$;

create trigger learner_issues_resolved_at
  before insert or update on learner_issues
  for each row
  execute function public.set_learner_issue_resolved_at();
