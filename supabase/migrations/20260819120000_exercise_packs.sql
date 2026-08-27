-- Unit 14R: authored exercise packs (pack-based diagnostic, per the pilot
-- training program this product is modeled on — see progress-tracker.md
-- 2026-08-19 direction change).
--
-- exercise_packs is server-only authored content, same discipline as
-- anomaly_templates: NO RLS policies for authenticated at all — read only via
-- the service-role client. The learner-facing copy of a pack (day-1 message,
-- file cards) is delivered through their own exercises row + signed URLs,
-- never by direct table access. answer_key here is the authored key seeded by
-- scripts/seed-pack.mjs (reviewed via seed/blossom-variant-a/
-- answer_key_review.md), copied into exercises.answer_key at assignment time
-- so per-learner immutability (architecture.md invariant 6) is preserved even
-- if the pack is later re-seeded.
create table exercise_packs (
  id uuid primary key default gen_random_uuid(),
  variant text not null check (variant in ('A', 'B')) unique,
  company_name text not null,
  -- Day-1 chat message template; {{name}} is replaced with the learner's
  -- name at assignment time.
  day1_message text not null,
  -- [{ "label": "Opening TB", "storage_path": "variant-a/1-opening-tb.xlsx" }, ...]
  pack_files jsonb not null,
  answer_key jsonb not null,
  expected_voucher_count integer not null,
  created_at timestamptz not null default now()
);

alter table exercise_packs enable row level security;
-- (no policies: service-role only)

-- A pack exercise's transactions live inside the pack FILES, not in the chat
-- scenario, so exercises.transactions is empty for them and the validity
-- gate's voucher-count check needs its own source of truth. Null for all
-- existing (generated) exercises — the gate falls back to transactions.length.
alter table exercises
  add column expected_voucher_count integer;

-- "Hi Elina." — the pilot's day-1 message is personalized by name. Captured at
-- onboarding (nullable: existing learners are prompted-by-fallback, the
-- template falls back to "there" rather than blocking).
alter table learner_profile
  add column full_name text;

-- Shared pack files bucket: same authored files served to every learner
-- (unlike the per-learner submissions / exercise-documents buckets, so the
-- select policy is not folder-scoped to auth.uid()). Uploads happen only via
-- the seed script's service-role client — no insert policy for authenticated.
insert into storage.buckets (id, name, public)
values ('packs', 'packs', false);

create policy "packs_select_authenticated"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'packs');
