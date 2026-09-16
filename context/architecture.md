# AIA Academy — Architecture

## 1. Stack

| Layer              | Technology                     | Role                                                                                                                                            |
| ------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend + Backend | Next.js (latest, App Router)   | Chat UI, onboarding flow, API routes, server actions                                                                                            |
| Language           | TypeScript                     | End-to-end type safety across UI, API, jobs, schemas                                                                                            |
| Database           | Supabase (Postgres)            | Learner state, exercises, answer keys, scoring results, mastery/error history, module progress                                                  |
| Auth               | Supabase Auth                  | Learner identity (email and password), session management                                                                                       |
| File storage       | Supabase Storage               | Uploaded XML submissions, generated PDF source documents, certificates                                                                          |
| LLM gateway        | OpenRouter                     | Routes calls to a pinned model for exercise generation, scoring, coaching, hints                                                                |
| LLM tracing        | Langfuse                       | Traces every LLM call (input, output, latency, cost) tagged by learner, module, call type                                                       |
| Output validation  | Zod                            | Validates every LLM JSON response against a strict schema before it touches app logic or storage                                                |
| XML parsing        | fast-xml-parser                | Parses Tally Detailed Day Book and Trial Balance XML into normalized vouchers                                                                   |
| Background jobs    | Inngest (or Trigger.dev)       | Durable, long-running workflows: multi-part submission waiting window, scoring pipeline, mastery/reinforcement recalculation, escalation checks |
| PDF generation     | @react-pdf/renderer            | Generates source documents (vendor bills, invoices, bank statements) as PDFs for exercises — chosen over pdf-lib (Unit 10)                      |
| Onboarding tour    | Navattic                       | Interactive product tour for AIA connector download + Tally connection                                                                          |
| Testing            | Vitest                         | Unit and integration tests, run in CI                                                                                                           |
| CI/CD              | GitHub Actions (or equivalent) | Test-on-push, build, deploy pipeline                                                                                                            |

Not included in v1: Sentry (explicitly deferred), Clerk (Supabase Auth only for v1).

## 2. System Boundaries — Folder Ownership

```
/app
  /(auth)                    → Sign-up, login, onboarding screens. No business logic — calls /lib.
  /(chat)                    → The tutor chat UI: message thread, file upload, hint requests.
  /(progress)                → Progress view, mastery map display, certificate page.
  /dashboard                 → Learner dashboard (page.tsx + actions.ts) — the landing surface after login.
  /auth/callback             → Supabase Auth callback route (session exchange after the email link redirect).
  /api
    /health                  → Liveness route, wired to the Docker Compose healthcheck.
    /inngest                 → Inngest sync endpoint and job callback receiver.
  /components
    ui/                      → Generic shadcn-style primitives (button.tsx, ProgressBar.tsx).
    site/                    → Landing page + auth-shell "day surface" components (SiteNav, Hero, HeroScene,
                               Tracks, Journey, WhySection, ConceptGrid, BuiltDifferent, Categories,
                               TutorVoices, FinalCta, SiteFooter, TrainingCard, CardCarousel, Bubbles,
                               MotionPreference, plus site-content.ts copy and site-motion.ts timings).
    Wordmark.tsx             → Shared mark + name, used by the day surface and the auth shell.

/lib
  /llm
    client.ts                → OpenRouter client wrapper, model pinning per call type
    tracing.ts               → Langfuse call tracing (input, output, latency, cost per call)
    prompts/                 → System prompts per call type (exercise-gen, scoring, coaching, hints, qa, adjudication)
    grounding/                → Rulebook, module-doc and video-module reference text, extracted for prompt grounding
  /schemas
    exercise.ts, scoring.ts, coaching.ts, state-patch.ts
                              → Zod schemas — the single contract between LLM output and app code
    chat-actions.ts           → Input schemas + invalid-input wording for chat Server Actions (2026-09-15)
    auth.ts                   → Credentials schema for logIn / signUp Server Actions (2026-09-15)
  /parsing
    daybook.ts, trialbalance.ts
                              → XML → normalized voucher/ledger structures. No scoring logic here.
  /tutor                      → Grading/generation engine, grouped by concern:
    generate-exercise.ts, generate-review-exercise.ts, assign-pack-exercise.ts, select-exercise-kind.ts,
      select-batch-concepts.ts, generation-checks.ts, documents-mode.ts
                              → Exercise generation and assignment
    score-submission.ts, score-qualitative.ts, ledger-findings.ts, adjudicate-findings.ts, rectification.ts,
      submission-gate.ts, books-reconciliation.ts, month-end-journals.ts
                              → Scoring, findings and the pre-scoring validity gate
    educational-dates.ts      → Tally Educational Mode dating (1st, 2nd, 31st only), enforced on generated batches (2026-09-16)
    generate-coaching.ts, generate-hint.ts, hint-ladder.ts
                              → Coaching and the hint ladder (includes findReusableDeepHint, 2026-09-15)
    correction-round.ts       → Correction-loop rules (2026-09-16): pure decision of whether a scored
                                batch opens another correction round or advances. No DB, no LLM
    major-modules.ts          → The five learner-facing modules (2026-09-16): overall progress fraction,
                                per-module breakdown, current module. A pure view over concept_mastery
    pair-tally-uploads.ts     → Sorts uploaded files into Day Book / Trial Balance pair (2026-09-15)
    submission-routing.ts     → Which text part a typed answer fills; which Inngest events to emit (2026-09-15)
    create-diagnostic-exercise.ts → Assigns authored-pack diagnostic or generates one (2026-09-15)
    mastery.ts, module-progress.ts
                              → Mastery, reinforcement, escalation state transitions and module advancement
    account-names.ts, answer-key-aliases.ts, timeline.ts
                              → Shared lookup/reference helpers used by the modules above
  /chat
    build-timeline.ts         → Chat-history rebuild: reassembles the full conversation from persisted rows (2026-08-24)
    message.ts                → Chat message types (moved 2026-09-15 from app/(chat)/chat/message.ts; lib no longer imports /app)
    exercise-content.ts       → Shared exercise-message copy, used by both the server timeline and the client live append
    issue-limits.ts           → Shared constant mirrored by the learner-issue schema and its DB check constraint
    report-issue.ts           → Learner issue reports (2026-09-15): validation, duplicate + hourly limits, batch-context snapshot, service-role insert. Never calls an LLM
    answer-learner-question.ts → Free-text Q&A (2026-09-15): answers learner questions grounded in Rulebook/docs/context, persists to qa_messages
    message-intent-rules.ts   → Smart Send's only classifier (2026-09-15; LLM tie-break removed 2026-09-16): decides question/answer/unclear on typed text during explain/review
    route-typed-message.ts    → Smart Send router: only a CLEAR question (per the rules) is answered directly; an answer OR unclear text returns needs-confirmation (the Submit card), so the learner decides and nothing is ever unfileable (2026-09-16)
    text-part-labels.ts       → Client-safe labels for submit button and confirmation states (2026-09-15)
  /db
    queries/                  → All Supabase reads/writes go through here — no ad-hoc queries in /app
      submission-files.ts     → Learner-scoped Storage paths and ordered uploads of submission's Day Book / Trial Balance (2026-09-15)
  /jobs
    client.ts                 → Inngest client instance
    wait-for-submission.ts    → Aggregates multi-part submissions within the wait window
    wait-for-parts.ts         → The multi-part wait, in 2-minute slices that re-read the DB, so a part whose event was missed or never sent is found within one slice rather than after the 45-minute window (2026-09-16)
    run-scoring.ts            → Triggered once validity gate passes
    advance-learner.ts        → Runs after scoring: logs concept attempts, recomputes mastery/module progress, triggers next-exercise generation (mastery recompute logic lives here, not in a separate recompute-mastery.ts)
  /documents
    generate-source-document.ts → LLM call producing validated structured document content (never a PDF/layout)
    render-source-document.ts   → Deterministic content → PDF buffer, no LLM involvement
    pick-template.ts, build-bank-statement.ts, build-sales-register.ts
                                 → Deterministic document assembly, no LLM involvement
    company-details.ts, party-directory.ts, bank-account-details.ts
                                 → Fixed reference/seed data used to populate generated documents
    templates/                   → @react-pdf/renderer templates, one per doc_type (vendor-invoice variants, bank-statement variants, sales-invoice.tsx, month-end-notes.tsx)
  /supabase
    client.ts, server.ts, service-role.ts → Browser, Server Component and service-role Supabase clients
  cn.ts                         → clsx + tailwind-merge class-name helper, used across /app

/supabase
  /migrations                → Schema, RLS policies — source of truth for DB structure

/scripts                     → One-off/admin scripts (migrations, backfills, seeding, PDF regeneration) — not part of the app runtime, run manually or via CI

/seed                        → Seed content: authored exercise-pack answer keys, and extracted rulebook/manager-spec reference text used at seed time

/xmls                        → Test fixtures: sample Daybook/Trial Balance XML for parsing/scoring tests and manual pilot submissions
```

**Rule of thumb:** `/app` renders and routes; it never talks to Supabase, OpenRouter, or the file system directly — everything goes through `/lib`. This keeps the scoring/mastery logic testable in isolation from the UI.

**Loading and error states (2026-09-15):** Every product route (`/chat`, `/progress`, `/dashboard`) and `/onboarding` has its own `loading.tsx` and `error.tsx`. `loading.tsx` is a Server Component skeleton copying the page's layout with `aria-busy="true"` and pulsing placeholders. `error.tsx` is a Client Component that never shows `error.message`, logs in `useEffect`, and shows `error.digest` as a "Reference code" only when one exists, with a "Try again" button and a safe-route link.

## 3. Storage Model

| Data                                                                                                                            | Location                                                                | Why                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Learner profile (license mode, Books Begin Date)                                                                                | Database                                                                | Small, structured, queried on every exercise generation                                                               |
| Mastery map, error history, hint-rung usage                                                                                     | Database (`jsonb` + relational tables)                                  | Needs to be queried and updated transactionally on every scoring event                                                |
| Generated exercise + hidden answer key                                                                                          | Database                                                                | Must never be exposed to the client; kept server-side only, referenced by ID                                          |
| Scoring results, error codes, feedback text                                                                                     | Database                                                                | Structured, drives progress view and next-exercise generation                                                         |
| Module/progress state, escalation flags                                                                                         | Database                                                                | Small, read on every chat load                                                                                        |
| Uploaded Daybook XML / Trial Balance XML                                                                                        | File Storage (Supabase Storage)                                         | Large, immutable once submitted, referenced by URL from a `submissions` DB row                                        |
| Generated PDF source documents (invoices, bank statements)                                                                      | File Storage                                                            | Large binary, generated once per exercise, served by URL                                                              |
| Authored exercise-pack files (diagnostic/capstone variants: Opening TB, Sales Register, Purchase Register, Bank Statement xlsx) | File Storage (seeded once, shared across learners — not per-learner)    | Fixed authored content; served by URL as download cards in the exercise message                                       |
| Authored answer keys for pack exercises                                                                                         | Database (`exercises.answer_key`, same column, same invariants)         | Written at seed time by an admin/seed path, not by an LLM call; immutable once a learner's exercise row references it |
| Rulebook + training-module reference text (extracted from the source .docx files)                                               | Repo (`/lib/llm/grounding/`) as extracted text, versioned with the code | Prompt grounding content; changes go through code review, same as prompts themselves                                  |
| Certificate PDF                                                                                                                 | File Storage                                                            | Generated once, served by URL, referenced from `learner_state`                                                        |
| In-flight multi-part submission buffer (waiting for daybook + explain + review)                                                 | Database (`submissions` row with nullable parts + `status: pending`)    | Needs to survive across the 30–45 min window and process restarts — not appropriate for an ephemeral cache            |
| Correction-round state (which round a submission is, whether the loop is still open)                                            | Database, derived from existing rows: `submissions.correction_round` + that submission's `concept_attempts` | The learner leaves for Tally between rounds, so nothing about the loop may live in client state. "Is a round open?" is re-derived on every chat load and after every scoring, never stored as a flag that could go stale |
| LLM call traces                                                                                                                 | Langfuse (external)                                                     | Not queried by the app at runtime; observability only                                                                 |
| Learner issue reports (message, status, owner reply, snapshot of the current exercise/submission)                               | Database (`learner_issues`)                                             | Read by the owner in Supabase; learners select their own rows only and have no write grant, inserts go through the service role after validation and a 5-per-hour limit |
| Rate limiting / short-lived dedupe (e.g. prevent duplicate hint requests within seconds)                                        | In-memory / edge cache                                                  | Only for data that's fine to lose on restart and never affects grading correctness                                    |

**Rule:** anything that affects grading correctness or mastery state lives in the database, never in a cache. Cache is only for throwaway, non-authoritative data.

## 4. Auth and Access Model

- **Authentication:** Supabase Auth (email and password).
- **Ownership model:** one `auth.users` row → one `learner_state` row (1:1). No org/team/role tables in v1 — that's Phase 3.
- **Row Level Security (RLS):** every learner-owned table (`learner_state`, `submissions`, `exercises`, `scoring_results`) has a policy scoped to `auth.uid() = learner_id`. A learner can never read or write another learner's row, enforced at the database level, not just in application code.
- **Service role usage:** the Supabase service-role key is used **only** in trusted server contexts — Server Actions, API routes, and background jobs — for operations that must bypass RLS (e.g. writing a scoring result computed by the backend, not the learner; or persisting a generated exercise's answer key, which learners have no RLS insert grant for). It is never exposed to the client bundle. Client `lib/supabase/service-role.ts` wraps `createClient` with the service-role key and `persistSession: false`.
- **Hidden answer key access:** the `exercises.answer_key` column is only ever read by server-side scoring code. No API route or query path returns it to the client, under any request shape.

## 5. AI and Background Task Model

**LLM call types (each with its own pinned model config, system prompt, and Zod schema):**

| Call type            | Trigger                                                                                                                                                    | Output schema                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exercise generation  | Start of an adaptive drill, or reinforcement trigger (NOT the diagnostic/capstone — those use authored packs with authored answer keys, no LLM generation) | `exercise.ts` (scenario, transactions, source docs, hidden answer key)                                                                                                                                                                                                                                                                                                                                                                        |
| Q&A response         | Learner sends a free-text question in chat                                                                                                                 | `qa.ts` (answer prose, optional rulebook/module-doc citations) — grounded in the Rulebook + module docs + current exercise context, never the answer key                                                                                                                                                                                                                                                                                      |
| Finding adjudication | After deterministic scoring, when findings exist (hybrid scoring, decision 2026-08-20)                                                                     | `adjudication.ts` (per-finding uphold/dismiss + reason) — the engine FINDS, the LLM JUDGES: dismissed findings (acceptable practice variations) flip to correct and the result is rebuilt; fail-safe to the engine's verdicts on any adjudication failure, so this call can only relax findings, never invent them. Runs server-side inside the scoring jobs; its prompt sees expected postings (same answer-key boundary as hint generation) |
| Scoring              | After validity gate passes on a submission                                                                                                                 | `scoring.ts` (per-voucher diffs, error codes, TB tie-out, weighted score)                                                                                                                                                                                                                                                                                                                                                                     |
| Coaching / feedback  | After scoring completes                                                                                                                                    | `coaching.ts` (opening line, praise and flagged-area bullets each citing fact ids, checked by `checkGrounding`; the next-step note is written in code, see invariant 7)                                                                                                                                                                                                                                                                                                                                                                            |
| Hint response        | Learner requests help                                                                                                                                      | `hint-ladder.ts` output (rung number, hint content)                                                                                                                                                                                                                                                                                                                                                                                           |
| Mastery/state patch  | After scoring                                                                                                                                              | `state-patch.ts` (mastery map delta, escalation flags)                                                                                                                                                                                                                                                                                                                                                                                        |
| Hint response (pushed) | A scored batch has a failing concept and a correction round opens (2026-09-16) | Same `hint-ladder.ts` output as a requested hint, with `focusConceptTag` set so the step aims at the concept that failed. A generation failure falls back to advancing the learner rather than leaving them with neither a hint nor a next batch |

Every LLM response is validated against its Zod schema before it is persisted or shown to the learner. On validation failure, the call is retried with the validation error fed back into the prompt (bounded retry count) — the app never falls back to unvalidated model output.

**Background jobs (Inngest/Trigger.dev):**

- **Submission wait job** — starts when the first part of a submission arrives, waits up to the configured window for the remaining parts (daybook, explain, review), then triggers scoring with whatever arrived, flagging missing parts.
- **Scoring job** — runs the validity gate, then parsing, then the scoring LLM call, then persists results.
- **Mastery recompute job** — runs after scoring, applies the state-patch, checks reinforcement (2-of-3 failure) and escalation (3 failures) rules, and triggers next-exercise generation if applicable.
- **Escalation check job** — flags learners who've hit escalation mode for progress-view visibility.

All jobs are durable — if the process restarts mid-window, the job resumes from its persisted state rather than restarting or being lost.

**No submission may stay blocked (2026-09-16).** Three rules keep an exercise from ever becoming unsubmittable:

- Both scoring jobs declare `onFailure`: once retries are exhausted, `markSubmissionFailedIfOpen` moves the submission to `invalid` (which a re-send starts clean from). The update is guarded on `status in ('validating', 'scoring')` inside the query, so a job that fails *after* persisting a score can never undo it.
- `submitFiles` catches a failed `inngest.send` and tells the learner to press Send again; the files stay attached, and the re-send rejoins the `validating` row, overwrites the files and re-sends the events. `submitTextPart` deliberately lets the throw reach the client, which keeps the confirmation card open; the retry of the same text re-sends the event and reports it filed.
- Uploads or typed parts sent while a submission is `scoring` get a plain "being scored right now" reply rather than rejoining it, since its files may not be overwritten and a second submission would score the exercise twice.

## 6. Deployment

- **Target:** self-hosted Hostinger VPS (`srv1701205.hstgr.cloud`), one Docker container (`ai-tutor`, at `/opt/Training-Module`) alongside the VPS's existing containers, managed by Docker Compose. Supabase, OpenRouter, Inngest, and Langfuse remain external SaaS — the container is stateless and disposable; all learner data lives in Supabase.
- **Live URL:** `https://ai-tutor.187-127-173-25.sslip.io` (confirmed working 2026-08-27).
- **Routing:** Traefik (`traefik-traefik-1`) already on the VPS, running `network_mode: host` with Docker-label discovery — no shared external network exists on this VPS. The app publishes to `127.0.0.1:$APP_PORT` (loopback only) and Traefik routes to a fixed `loadbalancer.server.url`, the same pattern every other app container on this VPS uses. Domain is a sslip.io address (`<label>.187-127-173-25.sslip.io`) — no DNS setup, HTTPS via Traefik's `letsencrypt` certresolver. `APP_DOMAIN`/`APP_PORT` in `.env` (both required, no defaults). Full wiring detail and the one-time post-deploy Traefik restart note: `DEPLOYMENT.md`.
- **Image:** multi-stage Dockerfile → Next.js `output: 'standalone'`, non-root user, runtime env injected via `env_file` (secrets never baked into layers; `.dockerignore` excludes `.env*`). `NEXT_PUBLIC_*` values are build args (inlined into the browser bundle).
- **Health:** `/api/health` liveness route, wired to the compose healthcheck (and available for uptime monitoring).
- **Deploys:** `git pull && docker compose up -d --build` on the VPS, or the manual-dispatch GitHub Actions workflow (`.github/workflows/deploy.yml`) that runs the same over SSH. Full runbook: `DEPLOYMENT.md`.
- **Production requirements:** `INNGEST_DEV` unset + real Inngest keys (done) + the app synced in Inngest Cloud at `<public-url>/api/inngest` (jobs silently queue forever otherwise); Supabase Auth Site/Redirect URLs pointed at the public URL.

## 7. Invariants

These rules must never be violated by any code path, feature, or shortcut:

1. **The hidden answer key never reaches the client.** No API response, prop, log line visible client-side, or LLM prompt shown to the learner may contain `exercises.answer_key` or any derivation of it that reveals the answer before scoring.

2. **A submission is never scored until it passes the pre-scoring validity gate.** If the XML is the wrong format, incomplete, or unparseable, the pipeline halts and requests a resubmission — it never guesses, partially scores, or silently skips missing data.

3. **All LLM output is validated against its Zod schema before being persisted or acted on.** Invalid output triggers a retry with bounded attempts; it is never persisted, never shown to the learner, and never silently coerced into a "close enough" shape.

4. **Row Level Security is the enforcement boundary for data ownership, not application logic.** Every learner-owned table has an RLS policy scoped to `auth.uid()`. Application code may add convenience checks, but must never be the _only_ thing preventing one learner from reading another's data.

5. **Mastery state changes only through the defined state-update pipeline** (`/lib/tutor/mastery.ts`, invoked from the mastery recompute job). No UI action, admin tool, or ad-hoc script may mutate `mastery_map`, `error_history`, or `hint_rung_usage` directly — mastery history must stay a complete, auditable trail of how a learner got to their current state.

6. **A generated exercise's answer key is immutable once created.** The same answer key that scored the first submission for that exercise scores any resubmission for it. Regenerating or editing an answer key after the fact would silently invalidate prior scoring and break the mastery history's integrity.

7. **Learner-facing coaching states only facts code has computed (2026-09-16).** `buildCoachingFacts` turns the scoring result into a closed, numbered fact list (P praise, I issue, U unmatched voucher, L ledger finding, T tie-out, B books, F fixed, S still failing, M missing part). The model may only phrase those facts: every `went_well`/`needs_work` bullet cites fact ids, and `checkGrounding` rejects any bullet whose identifiers or figures are not in its cited facts, any claim of history ("earlier round", "still recurring", "same as last time") without an F or S fact, any uncited issue fact, and any em dash. Rejected output is retried with the exact violations; after three attempts `composeFallbackCoaching` writes the review from the facts alone, never dropping a finding. `next_note` is never model text: it is composed in code from `decideCorrection`, computed before coaching so the note matches the correction round the job then opens. A first-time failure (NEW) produces no history fact at all. Adding a new kind of learner feedback means adding a fact kind and its validator rule, never loosening the check.

**Correction rounds (2026-09-16) make invariant 6's "any resubmission" a live path rather than a hypothetical.** A scored exercise now accepts up to three further submissions while its correction loop is open. Three guarantees hold that safe, and any change to the loop must preserve all three:

- **One exercise produces at most one next batch.** `generateNextExercise` is idempotent on the *exercise's* `created_at`, never the submission's. Keyed on the submission it would hand out a second batch per correction round, which is the 2026-09-07 production incident `hasScoredSubmissionForExercise` was added to stop.
- **Every round appends its own attempt rows.** `concept_attempts` is unique on `(learner_id, exercise_id, concept_tag, submission_id)`. Dropping `submission_id` from that key silently discards corrections and breaks invariant 5's auditable trail.
- **Help depth is counted per concept.** A pass with three or more help requests behind it never counts toward mastery, so charging every concept in a batch for help given on one of them would, with help now pushed automatically, stall mastery permanently.
