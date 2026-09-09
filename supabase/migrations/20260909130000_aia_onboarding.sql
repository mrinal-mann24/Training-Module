-- Documents mode onboarding (2026-09-09): when a learner crosses the
-- documents-mode threshold they get a one-time AI Accountant setup flow in
-- the chat (video + checklist). This stamp records completion so the flow
-- never shows twice. Same pattern as walkthrough_completed_at.

alter table learner_profile
  add column if not exists aia_onboarding_completed_at timestamptz;
