-- Carried rectifications (2026-09-22, rebuild Part B). When a delivered
-- batch turns out to have taught the wrong posting through OUR mistake (a
-- month-end note that cleared 39,900 from a Suspense ledger holding 5,000),
-- the stored answer key is NOT rewritten: it is what the learner was scored
-- against, and their Tally books mirror it. Instead the owner records the
-- correcting journal here and the learner's NEXT generated batch carries it
-- as a real transaction with its own answer-key legs, the way a firm
-- rectifies a posted month. Books, keys and scoring stay consistent at every
-- point in time (architecture.md invariant 6).
--
-- Rows are written by the owner (SQL generated per case under
-- scripts/corrections/) and read by the generators through the service-role
-- client (lib/db/queries/carried-rectifications.ts); a row is consumed once,
-- stamped with the exercise that carried it. Learners never see this table.
--
-- source_exercise_id is a plain snapshot with no foreign key, like
-- learner_issues: the owner's reset procedure deletes exercises, and a
-- pending rectification must not be deleted or nulled by a cascade.

create table carried_rectifications (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references auth.users (id) on delete cascade,
  source_exercise_id uuid,
  -- Owner-facing: which defect this corrects.
  reason text not null check (char_length(btrim(reason)) between 1 and 2000),
  -- What the learner reads, without a date (the generator dates it in the
  -- batch month). Every rupee figure in it must be a leg amount and every
  -- bill number a leg reference; lib/tutor/carried-rectifications.ts
  -- refuses the row otherwise.
  learner_text text not null check (char_length(btrim(learner_text)) between 1 and 1500),
  -- [{ account, dr_cr, amount, bill_reference?, narration? }], balanced.
  legs jsonb not null,
  created_at timestamptz not null default now(),
  carried_in_exercise_id uuid,
  carried_at timestamptz,
  check ((carried_in_exercise_id is null) = (carried_at is null))
);

create index carried_rectifications_pending_idx
  on carried_rectifications (learner_id, created_at)
  where carried_in_exercise_id is null;

alter table carried_rectifications enable row level security;

-- No policies: service-role only. The revokes are defence in depth over
-- Supabase's default grants; TRUNCATE is not governed by RLS at all.
revoke all on carried_rectifications from authenticated;
revoke all on carried_rectifications from anon;
