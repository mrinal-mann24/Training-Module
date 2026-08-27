# Unit 11: Multi-Part Submissions + Qualitative Scoring + Anomaly Seeding

## Goal

Qualitative modules (explain-the-entry, open ledger review) require more than a Daybook + Trial Balance upload — the learner also sends free-text answers as separate chat messages, which can arrive out of order over 30–45 minutes. This unit builds submission aggregation across parts, a durable wait-for-submission job (first real use of the timing behavior Unit 07's job infra was built to support), qualitative scoring for free-text answers (recall/precision/reasoning — necessarily LLM-judged, unlike Unit 06's deterministic diff, since natural language can't be code-diffed), and an anomaly-seeding library that draws on Unit 09's `company_transaction_log` to build ledger-review exercises.

**ASSUMPTION — flagging per `ai-workflow-rules.md` rule 13/14, this is a genuine open question, not a confident design choice:** the exact mechanics of "open ledger review with seeded anomalies" are ambiguous from what's specified so far — specifically, whether the learner is reviewing their *actual live Tally company* (requiring a fresh export to see current state) or a *review packet presented in chat* (a curated set of line items, some real from `company_transaction_log`, some injected anomaly variants, described in text). This spec builds the **review-packet-in-chat** version, since it's self-contained and doesn't require inventing a new submission type on top of what already exists. **Confirm this against the original spec before building** — if it's meant to be a live-company review requiring a fresh export, this unit's design changes meaningfully (it would need its own upload-and-diff flow, closer to Unit 05/06 than to free-text scoring).

## Design

Reference `context/ui-context.md`.

- While a multi-part submission is incomplete, show a small status checklist in the chat thread: each required part with a check (`status-success`) or pending (`text-muted`) indicator — e.g. "Daybook ✓ · Trial Balance ✓ · Explanation — waiting." Updates live (reuse Unit 07's Realtime pattern) as parts arrive.
- Free-text answers (explain, review) are sent as ordinary chat messages from the learner — no special input UI, just the existing composer.
- Qualitative feedback renders with the same feedback bubble structure as Unit 06, extended with a short note on recall/precision/reasoning framed in plain language ("you caught most of the real issues, but flagged one entry that was actually correct") — never raw subscores as numbers to the learner.

## Implementation

### Submission parts data model
- `submission_parts` table: `id`, `submission_id`, `part_type` (`'daybook_xml' | 'trialbalance_xml' | 'explain_text' | 'review_text'`), `content` (jsonb for text, storage path reference for files), `received_at`.
- Extend `exercises` with `required_parts` (array of `part_type`) — set at generation time based on exercise type. A direct-entry exercise still only requires the two file parts (unchanged from Units 05–07); an explain-the-entry exercise adds `explain_text`; a ledger-review exercise may require only `review_text` with no files at all.
- A submission is "complete" when all of its exercise's `required_parts` have a matching row; "partial" otherwise.

### Wait-for-submission job
- New Inngest function, replacing the direct trigger from Unit 07 for exercises with more than one required part: starts on the first part received, waits for the remaining required parts (via `step.waitForEvent`, one per expected part type) up to the configured window (30–45 minutes), then proceeds to scoring with whatever has arrived — missing parts are flagged in the feedback, never silently treated as failures or left unscored forever.
- Exercises requiring only the existing two file parts continue through Unit 07's original job unchanged — don't route simple submissions through the more complex waiting logic unnecessarily.

### Qualitative scoring
- `/lib/schemas/qualitative-scoring.ts`: Zod schema — `recall` (0–100, did they identify the real issues), `precision` (0–100, did they avoid flagging correct entries as wrong), `reasoning_quality` (0–100 or categorical), `rationale` (internal, not shown raw to learner).
- `/lib/tutor/score-qualitative.ts`: unlike Unit 06's deterministic diff, this **does** call the LLM, because free-text natural language genuinely can't be code-diffed. To keep this reliable, ground the call tightly: pass the learner's free text, the actual seeded issue list (server-only, from `ledger_review_items` below, same handling discipline as `answer_key`), and the Rulebook context. Validate against the schema, bounded retry on failure — same discipline as every other LLM call.
- Combine qualitative and quantitative (Unit 06) scores into the exercise's overall result when both apply.

### Anomaly seeding library
- `anomaly_templates` table: `id`, `concept_tag`, `anomaly_description` (server-only — what makes this wrong), `clean_distractor_description`, `difficulty_level`.
- `ledger_review_items` table (per exercise instance): `id`, `exercise_id`, `source` (`'real_transaction' | 'generated_distractor'`), `company_transaction_log_id` (nullable, references Unit 09's log when `source = 'real_transaction'`), `anomaly_template_id` (nullable), `is_anomaly` (boolean), `presented_text` (the learner-facing description shown in the review packet).
- `/lib/tutor/generate-review-exercise.ts`: selects a mix of real entries from `company_transaction_log` (some genuinely fine, some — if an uncorrected past error exists — genuinely anomalous) and library-seeded distractors, assembles the review packet, persists `ledger_review_items` as the server-only answer key for this exercise.

## Dependencies

No new packages — built on Units 04, 06, 07, and 09's existing infrastructure.

## Verify when done

- [ ] A multi-part exercise correctly waits for all required parts before scoring, confirmed by sending them out of order across a real delay (don't just test them arriving instantly)
- [ ] If the wait window expires with a part missing, scoring proceeds anyway and the feedback explicitly flags what wasn't received — never silently blocks forever
- [ ] Simple two-file exercises (Units 05–07's existing path) are unaffected — confirm no regression, they don't get routed through the more complex waiting logic
- [ ] Qualitative scoring produces sensible recall/precision/reasoning results against a constructed test case with known correct/incorrect flags
- [ ] Raw subscores are never shown to the learner as numbers — only plain-language framing
- [ ] `ledger_review_items` (the review exercise's answer key equivalent) is never exposed to the client, same discipline as `answer_key`
- [ ] A review packet correctly mixes real entries from `company_transaction_log` with library-seeded distractors, confirmed by inspecting at least one generated packet
- [ ] All new tables have RLS confirmed by direct test
- [ ] Status checklist UI updates live as parts arrive, using the existing Realtime pattern from Unit 07
- [ ] `npm run build` passes with no TypeScript errors
- [ ] **The open assumption in this spec (review-packet-in-chat vs. live-company export) has been explicitly confirmed against the original build spec before this unit is considered done** — this is not optional, it changes the design if wrong
