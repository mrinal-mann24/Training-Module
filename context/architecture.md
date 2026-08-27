# AI Tutor — Architecture

## 1. Stack

| Layer | Technology | Role |
|---|---|---|
| Frontend + Backend | Next.js (latest, App Router) | Chat UI, onboarding flow, API routes, server actions |
| Language | TypeScript | End-to-end type safety across UI, API, jobs, schemas |
| Database | Supabase (Postgres) | Learner state, exercises, answer keys, scoring results, mastery/error history, module progress |
| Auth | Supabase Auth | Learner identity (email and password), session management |
| File storage | Supabase Storage | Uploaded XML submissions, generated PDF source documents, certificates |
| LLM gateway | OpenRouter | Routes calls to a pinned model for exercise generation, scoring, coaching, hints |
| LLM tracing | Langfuse | Traces every LLM call (input, output, latency, cost) tagged by learner, module, call type |
| Output validation | Zod | Validates every LLM JSON response against a strict schema before it touches app logic or storage |
| XML parsing | fast-xml-parser | Parses Tally Detailed Day Book and Trial Balance XML into normalized vouchers |
| Background jobs | Inngest (or Trigger.dev) | Durable, long-running workflows: multi-part submission waiting window, scoring pipeline, mastery/reinforcement recalculation, escalation checks |
| PDF generation | @react-pdf/renderer | Generates source documents (vendor bills, invoices, bank statements) as PDFs for exercises — chosen over pdf-lib (Unit 10) |
| Onboarding tour | Navattic | Interactive product tour for AIA connector download + Tally connection |
| Testing | Vitest | Unit and integration tests, run in CI |
| CI/CD | GitHub Actions (or equivalent) | Test-on-push, build, deploy pipeline |

Not included in v1: Sentry (explicitly deferred), Clerk (Supabase Auth only for v1).

## 2. System Boundaries — Folder Ownership

```
/app
  /(auth)                    → Sign-up, login, onboarding screens. No business logic — calls /lib.
  /(chat)                    → The tutor chat UI: message thread, file upload, hint requests.
  /(progress)                → Progress view, mastery map display, certificate page.
  /api
    /submissions             → Receives uploads, hands off to jobs. Never scores inline.
    /webhooks                → Inngest/Trigger.dev callback endpoints.

/lib
  /llm
    client.ts                → OpenRouter client wrapper, model pinning per call type
    prompts/                 → System prompts per call type (exercise-gen, scoring, coaching, hints)
  /schemas
    exercise.ts, scoring.ts, coaching.ts, state-patch.ts
                              → Zod schemas — the single contract between LLM output and app code
  /parsing
    daybook.ts, trialbalance.ts
                              → XML → normalized voucher/ledger structures. No scoring logic here.
  /tutor
    generate-exercise.ts      → Builds exercise + hidden answer key together, persists both
    score-submission.ts       → Diffs parsed submission against answer key, applies error weighting
    hint-ladder.ts            → Rung selection and progression logic
    mastery.ts                → Mastery, reinforcement, escalation state transitions
  /chat
    build-timeline.ts         → Chat-history rebuild: reassembles the full conversation from persisted rows (2026-08-24)
  /db
    queries/                  → All Supabase reads/writes go through here — no ad-hoc queries in /app
  /jobs
    wait-for-submission.ts    → Aggregates multi-part submissions within the wait window
    run-scoring.ts            → Triggered once validity gate passes
    recompute-mastery.ts      → Runs after scoring, updates state
  /documents
    generate-source-document.ts → LLM call producing validated structured document content (never a PDF/layout)
    render-source-document.ts   → Deterministic content → PDF buffer, no LLM involvement
    templates/                  → @react-pdf/renderer templates, one per doc_type (vendor-invoice.tsx, bank-statement.tsx)

/supabase
  /migrations                → Schema, RLS policies — source of truth for DB structure
```

**Rule of thumb:** `/app` renders and routes; it never talks to Supabase, OpenRouter, or the file system directly — everything goes through `/lib`. This keeps the scoring/mastery logic testable in isolation from the UI.

## 3. Storage Model

| Data | Location | Why |
|---|---|---|
| Learner profile (license mode, Books Begin Date) | Database | Small, structured, queried on every exercise generation |
| Mastery map, error history, hint-rung usage | Database (`jsonb` + relational tables) | Needs to be queried and updated transactionally on every scoring event |
| Generated exercise + hidden answer key | Database | Must never be exposed to the client; kept server-side only, referenced by ID |
| Scoring results, error codes, feedback text | Database | Structured, drives progress view and next-exercise generation |
| Module/progress state, escalation flags | Database | Small, read on every chat load |
| Uploaded Daybook XML / Trial Balance XML | File Storage (Supabase Storage) | Large, immutable once submitted, referenced by URL from a `submissions` DB row |
| Generated PDF source documents (invoices, bank statements) | File Storage | Large binary, generated once per exercise, served by URL |
| Authored exercise-pack files (diagnostic/capstone variants: Opening TB, Sales Register, Purchase Register, Bank Statement xlsx) | File Storage (seeded once, shared across learners — not per-learner) | Fixed authored content; served by URL as download cards in the exercise message |
| Authored answer keys for pack exercises | Database (`exercises.answer_key`, same column, same invariants) | Written at seed time by an admin/seed path, not by an LLM call; immutable once a learner's exercise row references it |
| Rulebook + training-module reference text (extracted from the source .docx files) | Repo (`/lib/llm/grounding/`) as extracted text, versioned with the code | Prompt grounding content; changes go through code review, same as prompts themselves |
| Certificate PDF | File Storage | Generated once, served by URL, referenced from `learner_state` |
| In-flight multi-part submission buffer (waiting for daybook + explain + review) | Database (`submissions` row with nullable parts + `status: pending`) | Needs to survive across the 30–45 min window and process restarts — not appropriate for an ephemeral cache |
| LLM call traces | Langfuse (external) | Not queried by the app at runtime; observability only |
| Rate limiting / short-lived dedupe (e.g. prevent duplicate hint requests within seconds) | In-memory / edge cache | Only for data that's fine to lose on restart and never affects grading correctness |

**Rule:** anything that affects grading correctness or mastery state lives in the database, never in a cache. Cache is only for throwaway, non-authoritative data.

## 4. Auth and Access Model

- **Authentication:** Supabase Auth (email and password).
- **Ownership model:** one `auth.users` row → one `learner_state` row (1:1). No org/team/role tables in v1 — that's Phase 3.
- **Row Level Security (RLS):** every learner-owned table (`learner_state`, `submissions`, `exercises`, `scoring_results`) has a policy scoped to `auth.uid() = learner_id`. A learner can never read or write another learner's row, enforced at the database level, not just in application code.
- **Service role usage:** the Supabase service-role key is used **only** in trusted server contexts — Server Actions, API routes, and background jobs — for operations that must bypass RLS (e.g. writing a scoring result computed by the backend, not the learner; or persisting a generated exercise's answer key, which learners have no RLS insert grant for). It is never exposed to the client bundle. Client `lib/supabase/service-role.ts` wraps `createClient` with the service-role key and `persistSession: false`.
- **Hidden answer key access:** the `exercises.answer_key` column is only ever read by server-side scoring code. No API route or query path returns it to the client, under any request shape.

## 5. AI and Background Task Model

**LLM call types (each with its own pinned model config, system prompt, and Zod schema):**

| Call type | Trigger | Output schema |
|---|---|---|
| Exercise generation | Start of an adaptive drill, or reinforcement trigger (NOT the diagnostic/capstone — those use authored packs with authored answer keys, no LLM generation) | `exercise.ts` (scenario, transactions, source docs, hidden answer key) |
| Q&A response | Learner sends a free-text question in chat | `qa.ts` (answer prose, optional rulebook/module-doc citations) — grounded in the Rulebook + module docs + current exercise context, never the answer key |
| Finding adjudication | After deterministic scoring, when findings exist (hybrid scoring, decision 2026-08-20) | `adjudication.ts` (per-finding uphold/dismiss + reason) — the engine FINDS, the LLM JUDGES: dismissed findings (acceptable practice variations) flip to correct and the result is rebuilt; fail-safe to the engine's verdicts on any adjudication failure, so this call can only relax findings, never invent them. Runs server-side inside the scoring jobs; its prompt sees expected postings (same answer-key boundary as hint generation) |
| Scoring | After validity gate passes on a submission | `scoring.ts` (per-voucher diffs, error codes, TB tie-out, weighted score) |
| Coaching / feedback | After scoring completes | `coaching.ts` (result line, praise, flagged areas, next-step note) |
| Hint response | Learner requests help | `hint-ladder.ts` output (rung number, hint content) |
| Mastery/state patch | After scoring | `state-patch.ts` (mastery map delta, escalation flags) |

Every LLM response is validated against its Zod schema before it is persisted or shown to the learner. On validation failure, the call is retried with the validation error fed back into the prompt (bounded retry count) — the app never falls back to unvalidated model output.

**Background jobs (Inngest/Trigger.dev):**

- **Submission wait job** — starts when the first part of a submission arrives, waits up to the configured window for the remaining parts (daybook, explain, review), then triggers scoring with whatever arrived, flagging missing parts.
- **Scoring job** — runs the validity gate, then parsing, then the scoring LLM call, then persists results.
- **Mastery recompute job** — runs after scoring, applies the state-patch, checks reinforcement (2-of-3 failure) and escalation (3 failures) rules, and triggers next-exercise generation if applicable.
- **Escalation check job** — flags learners who've hit escalation mode for progress-view visibility.

All jobs are durable — if the process restarts mid-window, the job resumes from its persisted state rather than restarting or being lost.

## 6. Invariants

These rules must never be violated by any code path, feature, or shortcut:

1. **The hidden answer key never reaches the client.** No API response, prop, log line visible client-side, or LLM prompt shown to the learner may contain `exercises.answer_key` or any derivation of it that reveals the answer before scoring.

2. **A submission is never scored until it passes the pre-scoring validity gate.** If the XML is the wrong format, incomplete, or unparseable, the pipeline halts and requests a resubmission — it never guesses, partially scores, or silently skips missing data.

3. **All LLM output is validated against its Zod schema before being persisted or acted on.** Invalid output triggers a retry with bounded attempts; it is never persisted, never shown to the learner, and never silently coerced into a "close enough" shape.

4. **Row Level Security is the enforcement boundary for data ownership, not application logic.** Every learner-owned table has an RLS policy scoped to `auth.uid()`. Application code may add convenience checks, but must never be the *only* thing preventing one learner from reading another's data.

5. **Mastery state changes only through the defined state-update pipeline** (`/lib/tutor/mastery.ts`, invoked from the mastery recompute job). No UI action, admin tool, or ad-hoc script may mutate `mastery_map`, `error_history`, or `hint_rung_usage` directly — mastery history must stay a complete, auditable trail of how a learner got to their current state.

6. **A generated exercise's answer key is immutable once created.** The same answer key that scored the first submission for that exercise scores any resubmission for it. Regenerating or editing an answer key after the fact would silently invalidate prior scoring and break the mastery history's integrity.