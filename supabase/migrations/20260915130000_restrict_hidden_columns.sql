-- Audit fix (2026-09-15, finding #1, CRITICAL): row-level security scopes
-- WHICH ROWS a learner can read (auth.uid() = learner_id) but never
-- restricted WHICH COLUMNS, so any authenticated learner could call
-- supabase.from('exercises').select('answer_key').eq('id', exerciseId)
-- directly from the browser with their own session and read the hidden
-- answer key for their own exercise — the app code's careful
-- column-exclusion discipline (lib/db/queries/exercises.ts,
-- scoring-results.ts, ledger-review-items.ts all select() explicit safe
-- column lists) was defense-in-depth only, not the enforcement boundary
-- architecture.md invariant 4 requires RLS to be.
--
-- Column-level privileges layer on top of row-level security without
-- disturbing it: REVOKE SELECT (col) narrows what a role may retrieve, RLS's
-- USING clause still filters rows using learner_id regardless of whether
-- that column itself is in the revoked set (learner_id is NOT revoked here
-- precisely because ledger_review_items' policy needs to read exercises.id
-- and exercises.learner_id via its EXISTS subquery). This is the standard
-- Supabase-documented "column level security" pattern, paired with RLS
-- rather than replacing it.
--
-- Nothing else needs to change: every legitimate read of these columns
-- already goes through the service-role client (getExerciseAnswerKey,
-- getLedgerReviewItemsForExercise, insertScoringResult — verified via grep,
-- 2026-09-15), which is unaffected by a REVOKE scoped to `authenticated`.

-- exercises.answer_key: the hidden answer key itself (architecture.md
-- invariant 1).
revoke select (answer_key) on exercises from authenticated;

-- scoring_results.error_codes / qualitative_score: internal scoring detail,
-- never meant to be client-queryable even though RLS would technically
-- allow the learner to read their own row's full contents (the table's own
-- 2026-08-12 migration comment says exactly this).
revoke select (error_codes, qualitative_score) on scoring_results from authenticated;

-- ledger_review_items: the in-progress review exercise's answer-key
-- equivalent. is_anomaly/anomaly_template_id are the direct spoiler.
-- source is revoked too: source = 'real_transaction' currently implies
-- is_anomaly = false with 100% certainty (generate-review-exercise.ts's
-- selectRealEntries — real entries are never flagged anomalous), so source
-- alone already leaks half the packet's answers; company_transaction_log_id
-- is only meaningful paired with source, so it goes with it.
revoke select (source, company_transaction_log_id, anomaly_template_id, is_anomaly)
  on ledger_review_items from authenticated;
