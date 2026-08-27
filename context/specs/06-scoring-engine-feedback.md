# Unit 06: Scoring Engine + Answer Key Comparison + Coaching Feedback

## Goal

A submission sitting at `status: 'awaiting_scoring'` (from Unit 05) gets actually scored against its exercise's hidden answer key, and the learner receives real Socratic feedback in chat — a result line, honest praise, flagged areas to re-look at (not the exact fix), and a next-step note. This unit does **not** include the hint ladder (Unit 08), mastery tracking, or history-aware feedback like "this concept was fixed" (Unit 09) — feedback in this unit is scoped to a single submission only.

**Key architecture decision for this unit:** the actual correctness comparison (does this ledger match, is Dr/Cr right, is the GST head correct) is computed **deterministically in code**, not judged by the LLM. The LLM's only job here is turning an already-computed, precise diff into well-written, Socratic-toned feedback prose. This matters because accounting correctness needs to be exact and auditable — letting an LLM "eyeball" whether a GST classification is right would undermine the whole scoring model's reliability. Keep this boundary clean: `score-submission.ts` never calls the LLM, and the coaching call never re-derives correctness itself.

## Design

Reference `context/ui-context.md`.

- Feedback renders as an assistant chat message, same bubble style as before.
- A small result badge above the feedback text: `status-success` tint for a clean pass, `status-warning` tint for partial, `status-error` tint for a real miss — text label, not just color, since color alone shouldn't carry the meaning.
- Feedback structure inside the bubble, in order: result line (bold, one line), a short paragraph of specific praise, a short list of flagged areas ("take another look at how you handled the GST on the purchase entry" — concept-level, never "you should have used IGST not CGST/SGST," which would be the answer), one line on what's next.
- Never render raw error codes, internal weighting numbers, or anything from `answer_key` in this bubble — only the composed `feedback_text` fields from the coaching schema.

## Implementation

### Scoring schema and logic
- `/lib/schemas/scoring.ts`: Zod schema for the scoring result — `per_voucher_diffs` (array of `{ voucherRef, field, expected_masked: boolean, is_correct, error_code }` — note `expected_masked` rather than ever including the actual expected value in anything that could leak to the client), `tb_tie_out` (boolean), `weighted_score` (number), `overall_result` (`'pass' | 'partial' | 'fail'`).
- `/lib/tutor/score-submission.ts`: pure function, no LLM call. Takes the Unit 05 normalized voucher data and the exercise's `answer_key`, and:
  - Diffs each voucher's ledger classification, Dr/Cr direction, GST head + rate, TDS section + rate + base, voucher type, bill-by-bill reference, and narration against the answer key.
  - Computes Trial Balance tie-out: does the parsed TB's closing balances match what the answer key's correct posting would produce.
  - Tags each mismatch with an internal error code (e.g. `GST_HEAD_WRONG`, `DR_CR_REVERSED`, `NARRATION_MISSING`).
  - Applies 2x weighting to GST and TDS-related error codes when computing `weighted_score`.
  - Determines `overall_result` from the weighted score against defined thresholds (define the thresholds in this file, e.g. constants, not magic numbers scattered in logic).

### Coaching schema and LLM call
- `/lib/schemas/coaching.ts`: Zod schema — `result_line`, `praise` (string), `flagged_areas` (string array, concept-level only), `next_step_note`.
- `/lib/tutor/generate-coaching.ts`: takes the **scoring result** (not the raw answer key, not the raw diffs with internal codes — pass in enough structured signal for the LLM to write about, e.g. "GST head was miscategorized on the purchase voucher" as a concept description, not the literal expected/actual values) and the Rulebook grounding context, calls the LLM via the existing `/lib/llm/client.ts`, validates against the coaching schema, retries on validation failure (same bounded-retry pattern as Unit 04).
- Langfuse trace for this call, tagged `call_type: 'coaching'`.

### Wiring into the submission flow
- Extend the Unit 05 Server Action: once a submission reaches `status: 'awaiting_scoring'`, immediately call `score-submission.ts` (still synchronous for this unit — Unit 07 is what makes this durable, don't build job infra here), then `generate-coaching.ts`, then persist and render.
- `scoring_results` table: `id`, `submission_id`, `exercise_id`, `learner_id`, `weighted_score`, `tb_tie_out`, `error_codes` (jsonb, internal — never selected by any client-facing query), `overall_result`, `feedback_text` (jsonb: the coaching schema's output), `created_at`.
- RLS: learner can `select` only their own rows. As with `exercises.answer_key` in Unit 04, enforce at the query layer too: `/lib/db/queries/scoring-results.ts` exposes a `getFeedbackForLearner` that explicitly selects only `overall_result` and `feedback_text` — never `error_codes` — regardless of what RLS would technically allow.

## Dependencies

No new packages — this unit is built entirely on what Units 04–05 already introduced (LLM client, Zod, Langfuse, parsed voucher data).

## Verify when done

- [ ] `score-submission.ts` is tested against the worked example (the one from the build spec's Appendix D, if available, or a constructed equivalent) and produces the correct diffs, tie-out result, and weighted score by hand-verification, not just "it ran without erroring"
- [ ] GST/TDS error codes are confirmed to weight 2x in the score — test with a case that has one GST error and one narration error and confirm the score reflects the weighting difference
- [ ] `score-submission.ts` makes no LLM call — confirm this by inspecting the file, not just behavior
- [ ] Coaching feedback is generated via the LLM, validated against the Zod schema, with a bounded retry on malformed output
- [ ] Feedback text flags concept-level areas, never states the literal correct answer, verified by reading actual generated output against a known-wrong submission
- [ ] `answer_key` and `error_codes` never appear in any client-facing network response — check the actual payload
- [ ] Result badge (`pass`/`partial`/`fail`) renders with the correct token-based color and matches `overall_result`
- [ ] `scoring_results` RLS confirmed by direct test
- [ ] Langfuse trace exists for the coaching call, tagged correctly
- [ ] Re-submitting after a rejection (Unit 05's resubmission path) correctly triggers scoring on the corrected submission
- [ ] `npm run build` passes with no TypeScript errors
- [ ] No hint ladder, mastery tracking, or history-aware feedback ("this was fixed," "this is still failing") exists in this unit — that's Units 08 and 09