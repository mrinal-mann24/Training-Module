-- Persistent chat history (user decision 2026-08-24: the chat must survive a
-- refresh like GPT/Claude — the full conversation is rebuilt server-side on
-- load). Almost everything already persists (exercises, submissions,
-- scoring_results.feedback_text, hint_requests); the two gaps:
--
-- 1. Q&A exchanges were never stored anywhere. One row per exchange
--    (question + answer together — they're created atomically by the
--    askQuestion action after the LLM answers).
create table qa_messages (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references auth.users (id) on delete cascade,
  question text not null,
  answer text not null,
  created_at timestamptz not null default now()
);

alter table qa_messages enable row level security;

create policy "qa_messages_select_own"
  on qa_messages for select
  to authenticated
  using (auth.uid() = learner_id);

-- Learners insert their own exchanges (the answer is composed server-side in
-- the action, but written through the authenticated client — the row itself
-- is safe for the learner to write, same reasoning as hint_requests).
create policy "qa_messages_insert_own"
  on qa_messages for insert
  to authenticated
  with check (auth.uid() = learner_id);

-- 2. Original upload filenames were lost (Storage paths are normalized to
--    daybook.xml/trialbalance.xml), so rebuilt history couldn't show the
--    real chips ("Blossom Retail Pvt Ltd daybook.xml"). Nullable — older
--    submissions render generic labels.
alter table submissions
  add column daybook_filename text,
  add column trialbalance_filename text;
