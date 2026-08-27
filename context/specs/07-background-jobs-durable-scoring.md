# Unit 07: Background Jobs + Durable Scoring

## Goal

Take the synchronous validity-gate → score → coach pipeline built inline in Units 05–06 and move it onto a durable background job runtime (Inngest). The upload Server Action returns immediately instead of blocking on the full pipeline, the job survives a process restart mid-run, and the chat UI updates live when the result is ready — via a real-time subscription, not polling or a page refresh. This unit does **not** yet build the multi-part, out-of-order submission waiting window (30–45 minutes, explain + review messages) — that's Unit 11, introduced only when qualitative modules actually need it. This unit's job only wraps the existing single daybook+TB pair pipeline.

## Design

Reference `context/ui-context.md`.

- While a submission is processing, the chat shows a status indicator using the `ai-thinking` token — same visual language as the "tutor is composing a response" state from Unit 04, so it doesn't look like a new, different kind of loading state.
- No polling spinner-and-refresh pattern — the result should appear in the thread on its own once ready, via a live subscription.
- Everything else (feedback bubble styling, error message styling) is unchanged from Units 05–06 — this unit changes *how* the result arrives, not what it looks like.

## Implementation

### Job runtime setup
- Install Inngest, add the Route Handler serve endpoint (`/app/api/inngest/route.ts`) per its Next.js integration pattern.
- Add required environment variables (event key, signing key) to `.env.local` and `.env.example` (placeholders only in the example file).

### Refactor the upload flow to be event-driven
- Unit 05's upload Server Action changes: upload files to Storage, create the `submissions` row (`status: 'validating'`), send a `submission/uploaded` event to Inngest with the submission ID, then return immediately. It no longer awaits parsing, the gate, scoring, or coaching.
- Update `submissions.status` to the fuller set: `'validating' | 'invalid' | 'scoring' | 'scored'`. (`'awaiting_scoring'` from Unit 05 is superseded by this more granular set — update any code still referencing it.)

### The Inngest function
- One function, triggered by `submission/uploaded`, steps in order (each wrapped in `step.run` so Inngest can retry a failed step without re-running completed ones):
  1. Fetch the submission and its exercise.
  2. Parse both XML files (reuse Unit 05's parsing code as-is — do not duplicate it inside the job).
  3. Run the validity gate (reuse Unit 05's `submission-gate.ts` as-is). If invalid: update `status: 'invalid'`, store `validity_errors`, done.
  4. If valid: update `status: 'scoring'`, run `score-submission.ts` (reuse Unit 06's code as-is, no LLM call here per Unit 06's design).
  5. Run `generate-coaching.ts` (reuse Unit 06's code as-is).
  6. Persist the `scoring_results` row, update `submissions.status: 'scored'`.
- No business logic is rewritten in this unit — Units 05 and 06's functions are called from inside job steps, not reimplemented. If this unit finds itself duplicating logic instead of importing it, that's a sign the refactor is wrong.
- Idempotency: rely on `step.run`'s built-in memoization for retry safety. Confirm no code path can create a duplicate `scoring_results` row if a step retries after a partial failure (e.g. check-then-insert, or an upsert keyed on `submission_id`).

### Live updates to the client
- Use Supabase Realtime: the chat UI subscribes to changes on the current submission's row (or the eventual `scoring_results` insert) filtered to the learner's own data.
- Confirm Realtime respects the existing RLS policy — a learner's subscription must not be able to receive another learner's row updates. Test this directly, not just assumed from RLS being enabled on the table generally.
- On status change to `'invalid'` or `'scored'`, the client renders the corresponding message (unchanged from Units 05–06) — this unit only changes the delivery mechanism.

## Dependencies

- `inngest` (npm package)
- No new Supabase package — Realtime is part of `@supabase/supabase-js`, already installed.

## Verify when done

- [ ] The upload Server Action returns immediately (test: confirm the response comes back before scoring would realistically be done, not after)
- [ ] The Inngest function runs the full gate → score → coach pipeline end to end and produces the same result as Units 05–06 did synchronously — no regression in correctness
- [ ] Killing the dev server mid-job and restarting it results in the job resuming/completing correctly, not silently lost (this is the actual point of this unit — verify it deliberately, don't skip it because "it probably works")
- [ ] The chat UI shows the `ai-thinking` status while `status` is `'validating'` or `'scoring'`, and updates live to the final message when `status` becomes `'invalid'` or `'scored'` — no manual refresh needed
- [ ] Realtime updates are confirmed learner-scoped by direct test (one learner cannot receive another's status updates)
- [ ] No duplicate `scoring_results` row is created if a job step is retried
- [ ] Units 05 and 06's logic is reused via import, not duplicated inside the Inngest function — confirm by checking there's exactly one implementation of parsing, the gate, scoring, and coaching in the codebase
- [ ] `npm run build` passes with no TypeScript errors
- [ ] No multi-part/out-of-order submission handling (explain messages, review messages, 30–45 minute wait window) exists yet — that's Unit 11