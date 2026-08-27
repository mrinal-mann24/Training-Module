# Unit 08: Hint Ladder

## Goal

When a learner is stuck on an exercise and asks for help in chat, the tutor climbs a 5-rung hint ladder — one rung per genuine attempt, never skipping ahead, always eventually landing on rung 5 (the full worked answer) so nobody stays permanently stuck. This unit does not yet feed hint usage into mastery scoring ("heavy rung 4/5 use blocks mastery credit") — that connection is Unit 09's job, once the mastery engine exists to consume it. This unit only builds the ladder itself and records what rung was used, for Unit 09 to read later.

## Design

Reference `context/ui-context.md`.

- A visible "I'm stuck" or "Ask for a hint" affordance in the composer area, available once an exercise is active (not during the walkthrough, not before an exercise has been delivered).
- Hint responses render as ordinary assistant chat bubbles — no special "hint mode" visual treatment beyond the `ai-hint-rung` token (accent-subtle background, accent text) as a small label on the bubble, e.g. "Hint 2 of 5" — using the flat, non-escalating styling already defined in `ui-context.md` (all rungs look the same regardless of number, deliberately not an alarming red-ramp).
- The button that requests a hint should make clear that asking again will move to the next rung, not repeat the same one — e.g. label it "Still stuck? Get another hint" after the first hint has been given, rather than a generic repeatable "Get a hint" button.

## Implementation

### Data model
- Add a `hint_requests` table: `id`, `submission_id` (or `exercise_id` if hints can be requested before a submission exists — confirm this against the actual UX: a learner might ask for a hint while still working in Tally, before ever uploading anything, so tie hints to `exercise_id` + `learner_id`, not to a submission), `rung` (1–5), `hint_content` (jsonb — the rendered hint), `created_at`.
- RLS: learner can `select`/`insert` only their own rows.

### Rung progression logic
- `/lib/tutor/hint-ladder.ts`: given the learner's current exercise and their existing `hint_requests` for it, determine the next rung. Rung = (count of prior hint requests for this exercise) + 1, capped at 5 — once rung 5 has been given, further requests return rung 5 again (the full answer), never error or dead-end.
- Rung content, per the spec's 5-rung structure:
  1. **Direction** — a nudge pointing at the right area to look, no content yet.
  2. **Video pointer** — a reference to a specific video (concept tag + timestamp) with a guiding question. Since the actual video library doesn't exist yet (Modules is still a placeholder per Unit 04), this rung should reference a *placeholder* video slot — store the concept tag now, wire up the real link when video content exists later. Don't block this unit on video content being real.
  3. **Simpler analogue problem** — a smaller, structurally similar problem the learner can reason through.
  4. **The stated rule in plain words** — states the accounting rule directly, still without applying it to their specific exercise.
  5. **Full worked answer** — the complete answer for this specific exercise, plus a check-for-understanding question.
- Each rung's content is generated via an LLM call (new call type, `hint-generation`), grounded in the exercise's `answer_key` (server-side only, same handling discipline as scoring — the *hint itself* is allowed to reveal progressively more of the answer by design, but the raw `answer_key` object structure itself is never returned to the client, only the composed hint text).

### Hint schema and LLM call
- `/lib/schemas/hint.ts`: Zod schema — `rung` (1–5), `hint_text`, `concept_tag`.
- `/lib/tutor/generate-hint.ts`: builds the rung-appropriate prompt (different instructions per rung — rung 1 must not leak as much as rung 4), calls the LLM, validates against the schema, retries on failure.
- Langfuse trace, `call_type: 'hint-generation'`, tagged with rung number.

### UI and Server Action
- "Ask for a hint" button triggers a Server Action: determines the next rung, calls `generate-hint.ts`, persists the `hint_requests` row, renders the hint as an assistant message with its rung label.
- Track and expose rung depth per exercise somewhere queryable (`getHintDepthForExercise(learnerId, exerciseId)`) — Unit 09 will need this, but this unit only needs to make the data correctly queryable, not consume it yet.

## Dependencies

No new packages — built entirely on the LLM/Zod/Langfuse plumbing already established in Unit 04.

## Verify when done

- [ ] Requesting a hint for the first time on an exercise returns rung 1 content
- [ ] Requesting again returns rung 2, then 3, then 4, then 5 — confirmed by actually clicking through five times, not just reading the logic
- [ ] Requesting a sixth time returns rung 5 again (the full answer), not an error or a repeat of an earlier rung
- [ ] Rung 5's content is genuinely the full worked answer, not a stronger version of rung 4 — check this isn't watered down
- [ ] Rung 2's video reference uses a placeholder concept-tag pointer, doesn't break because no real video library exists yet
- [ ] Hints for one exercise don't leak into or affect hint rung state for a different exercise (test by requesting hints on two different exercises and confirming independent rung tracking)
- [ ] The hint button's label correctly reflects "get the next hint" once at least one has been given, not a generic repeatable label
- [ ] All rung bubbles use the flat, non-escalating `ai-hint-rung` styling — visually confirm rung 1 and rung 5 don't look alarmingly different from each other
- [ ] `answer_key`'s raw structure is never returned to the client — only the composed `hint_text` — check the actual network payload, even on rung 5
- [ ] `hint_requests` RLS confirmed by direct test
- [ ] Langfuse trace exists for hint generation calls, tagged with rung number
- [ ] `npm run build` passes with no TypeScript errors
- [ ] No mastery-engine logic reads or reacts to hint depth yet — that connection is Unit 09