# Unit 04: Dashboard Landing + Chat Shell + Guided Walkthrough + Diagnostic Exercise

## Goal

After onboarding, a learner sees a two-box dashboard (Modules placeholder, Task). Clicking Task opens a ChatGPT/Claude-style chat shell. Before any exercise appears, the learner steps through a short guided walkthrough (Next → Next → "I understand") that includes the Educational Mode disclosure and the Books Begin Date instruction. Once confirmed, the diagnostic exercise is generated through the real LLM pipeline (OpenRouter, Zod-validated, Langfuse-traced) and appears in chat. This is the first unit where the LLM plumbing exists at all — it must be built correctly here since every later unit depends on this pipeline shape.

**ASSUMPTION (flagging per `ai-workflow-rules.md` rule 14):** `03-onboarding.md` currently asks the learner to enter/confirm a Books Begin Date. That's being corrected — Books Begin Date is a fixed value (01-Apr-2026), never learner-entered, and should be *told* to the learner in this unit's walkthrough instead. Per instruction, `03-onboarding.md` and its implementation are not being revised yet. This unit proceeds using the corrected design (hardcoded 01-Apr-2026, told not asked) and treats reconciling Unit 03's form as a known follow-up, not something to fix now.

## Design

Reference `context/ui-context.md` — no new tokens.

- **Dashboard** (`/dashboard`): two cards side by side (stack on mobile). "Modules" card — `bg-surface`, `radius-xl`, visibly disabled/muted state (lower opacity or a "Coming soon" label), not clickable. "Task" card — same shape, `accent` border or accent icon to signal it's the active path, clickable.
- **Chat shell**: standard three-part layout — scrollable message thread, fixed composer at the bottom. Assistant messages use `bg-surface` bubbles, `radius-lg`, left-aligned. Learner messages use `bg-user-bubble`, `radius-lg`, right-aligned. Use the `ai-thinking` token for the generating/typing indicator while the LLM call is in flight.
- **Walkthrough messages** render as assistant chat bubbles like any other message — not a separate modal or overlay. Each step ends with a "Next" button (accent, `radius-md`) except the final step, which ends with "I understand." Buttons appear inline below the relevant message, not in the composer.
- Walkthrough content, in order: (1) welcome / what this chat is for, (2) Educational Mode disclosure if `license_mode === 'educational'` (skip this step entirely if licensed), (3) Books Begin Date instruction — "Set your Books Begin Date to 01-Apr-2026 in Tally before starting" — same step for everyone, (4) what happens next (they'll get an exercise, do it in Tally, upload the exports). Final button is "I understand."

## Implementation

### Dashboard
- `/dashboard` route, Server Component, reads `learner_profile` to confirm onboarding is complete (redirect to `/onboarding` if not, reusing Unit 03's gate).
- Two cards as described. Modules card has no route — it's non-interactive. Task card links to `/chat`.

### Chat shell scaffolding
- `/chat` route with message thread (Client Component, since it needs local state for streaming/incoming messages) and composer.
- Message list renders from an array of typed message objects (`role: 'assistant' | 'learner'`, `content`, `kind: 'walkthrough' | 'exercise' | ...`) — define this type now, it will grow in later units, don't over-build it.
- No file upload control yet — that's Unit 05. The composer in this unit only needs to support the walkthrough's button interactions; a text input can exist but has nothing to do yet (disable it until the diagnostic exercise has been delivered, to avoid a dead/confusing input).

### Walkthrough state and persistence
- Add a `walkthrough_completed_at` column to `learner_profile` (new migration) so the walkthrough is shown once, not on every visit to `/chat`.
- Walkthrough content itself is static (not LLM-generated) — it's fixed instructional text, conditionally including/excluding the Educational Mode step based on `license_mode`. Render it client-side from a small static config, not a database table.
- On "I understand," a Server Action sets `walkthrough_completed_at`, then triggers diagnostic exercise generation.

### LLM plumbing (first introduction — build this carefully)
- `/lib/llm/client.ts`: OpenRouter client wrapper. Model is pinned via an environment variable (`OPENROUTER_MODEL`), not hardcoded inline, so it can be changed without a code change. Confirm the chosen model supports forced structured output / tool calling before wiring the rest of this unit around it.
- `/lib/schemas/exercise.ts`: Zod schema for a generated exercise. At minimum: `scenario` (learner-facing prose), `transactions` (structured list), `answer_key` (server-only — never included in any type/shape that a client-facing response uses), `difficulty_level`, `variant` (`'A' | 'B'`).
- `/lib/tutor/generate-exercise.ts`: builds the prompt for the diagnostic specifically (fixed scenario template, deterministic variant selection — e.g. hash of learner ID picks A or B, not random, so it's reproducible), calls the LLM client, validates the response against the Zod schema, retries with the validation error fed back into the prompt on failure (bounded attempts), persists the result.
- `/lib/llm/tracing.ts`: Langfuse wrapper around the OpenRouter call — trace name, learner ID, call type (`diagnostic-generation`) attached as metadata to every call from this unit onward.

### Database
- `exercises` table: `id`, `learner_id` (references `auth.users`), `kind` (`'diagnostic' | ...` — extend later), `scenario` (jsonb, learner-facing), `answer_key` (jsonb, server-only), `variant`, `created_at`.
- RLS: learner can `select` only their own rows, and only non-answer-key fields should ever be selected by any client-facing query — enforce this at the query layer (`/lib/db/queries/exercises.ts` exposes a `getExerciseForLearner` that explicitly excludes `answer_key` from its select, rather than relying on RLS alone to hide a column within a row the learner does own).

### Delivering the exercise
- Once generated and persisted, the exercise's `scenario` content is rendered as the next chat message(s), replacing the disabled composer state with an active one (learner can now type, ahead of Unit 05's actual submission mechanism).

## Dependencies

- OpenRouter SDK or a thin `fetch`-based client (agent's choice, document which)
- `zod` (already a project convention from Unit 03)
- Langfuse SDK
- No XML parsing, no PDF generation, no background job runtime yet — none of those are needed until Units 05, 07, and 10.

## Verify when done

- [ ] Dashboard shows both cards; Modules is visibly non-interactive; Task navigates to `/chat`
- [ ] Chat shell renders assistant/learner bubbles with correct token-based styling in both light and dark mode
- [ ] Walkthrough shows the Educational Mode step only for `license_mode === 'educational'` learners, confirmed with one account of each mode
- [ ] Books Begin Date instruction appears as a told instruction ("set it to 01-Apr-2026"), not a form field, anywhere in this unit
- [ ] Walkthrough shows only once per learner — revisiting `/chat` after completion skips straight to the exercise (or later state), never replays the walkthrough
- [ ] "I understand" reliably triggers exercise generation exactly once — confirm no duplicate exercise row is created on double-click or refresh
- [ ] The LLM call is validated against the Zod schema; a deliberately malformed response (test by temporarily breaking the schema or mocking a bad response) triggers a retry, not a crash or silent bad data
- [ ] `answer_key` never appears in any client-facing network response — check the actual network payload, not just the UI
- [ ] Langfuse shows a trace for the diagnostic generation call with learner ID and call type attached
- [ ] RLS confirmed: one learner cannot read another learner's `exercises` row
- [ ] Diagnostic variant assignment is deterministic per learner (same learner always gets the same variant if regenerated in testing), not random
- [ ] `npm run build` passes with no TypeScript errors
- [ ] No submission/upload UI exists yet — that's Unit 05