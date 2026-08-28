# AIA Academy — Project Overview

## Overview

AIA Academy is a self-serve, chat-based training product that makes B.Com fresh graduates proficient in real-world bookkeeping. Learners work practical accounting scenarios inside their own copy of Tally, submit their Tally exports (Detailed Day Book XML and Trial Balance XML) into a chat interface, and an AIA Academy scores the submission against a hidden answer key, gives Socratic (non-answer-revealing) feedback, and generates the next exercise targeted at whatever the learner is weakest at. Early modules are pure Tally so learners build real accounting judgment by hand. Once the AIA Academy judges a learner's mechanics solid, it runs an interactive Navattic product tour to onboard them onto AI Accountant (AIA), and later exercises are completed using AIA (bill/statement ingestion, categorization, sync to Tally) instead of manual entry — while grading continues to happen on the same Tally export as before, so the standard of correctness never changes. The system tracks per-concept mastery over multiple attempts (not one-off correctness), reinforces weak concepts by regenerating targeted exercises, and never leaves a learner permanently stuck: a graduated hint ladder always eventually reaches the full answer. The journey ends in a full messy-client-month capstone, a re-run of the original diagnostic to show measurable improvement, and a certificate.

## Goals

1. Take a B.Com fresher with textbook knowledge but no real bookkeeping experience and make them genuinely proficient in Tally-based accounting, not just "completed the course."
2. Replace one-off correctness with measured mastery: a concept is only "done" after repeated clean application across multiple exercises, not a single lucky submission.
3. Personalize every exercise, hint, and piece of feedback from the learner's own stored error and mastery history, not a fixed curriculum queue.
4. Get learners fluent in AI Accountant (AIA) as a faster path to the same correct books, introduced only after core accounting judgment is solid, and always verified against the same Tally export standard.
5. Never let a learner get permanently stuck: coaching climbs a graduated hint ladder that always eventually resolves to a full answer, so self-serve learners don't churn from being stuck with no human reviewer.
6. Keep the tutor's judgments grounded in a single source of truth (the Karbon VA House Practices Rulebook) so scoring, coaching, and feedback are consistent and defensible.
7. Produce a certificate and a measurable before/after (diagnostic re-run at the capstone) as proof of the learner's improvement.

## Core User Flow (Start to Finish)

1. **Sign up.** Learner creates an account (Supabase Auth — Google OAuth or magic link).
2. **Onboarding.** Learner answers two one-time questions: Tally licensing status (`licensed` or `educational`), and confirmation of Books Begin Date (01-Apr-2026). The tool shows a one-time disclosure if Educational Mode is selected, since that mode restricts voucher entry to the 1st, 2nd, and last day of any month. The tool also points them to export instructions for later.
3. **Dashboard landing screen.** After onboarding, the learner lands on a screen with two boxes: **Modules** (a placeholder for now — 5–6 video slots, no functional content yet, added in a later phase) and **Task** (opens the chat shell — the real, functional path). Clicking Task is the only way forward at this stage.
4. **In-chat guided walkthrough.** Inside the chat shell, before any exercise appears, the tutor delivers a short guided walkthrough (Educational Mode disclosure, how submission works, etc.) as a sequence of chat messages the learner steps through with Next → Next → "I understand." Only after confirming does the flow continue.
5. **Diagnostic exercise.** Every learner gets the same starting exercise (one of two seeded variants), now appearing in the chat shell after the walkthrough is confirmed. The diagnostic is an **authored file pack**, not a generated scenario: a set of source files (Opening Trial Balance, Sales Register, Purchase Register, Bank Statement — e.g. `BlossomRetail_Variant_A`) presented as downloadable cards in the chat, with a hand-authored answer key stored server-side. The learner works the full pack in their own Tally instance and submits the usual Day Book + Trial Balance exports. This is scored but not taught — it sets their starting mastery map and level, and is later re-run at the capstone to measure improvement. (Decision 2026-08-19, from the live pilot training program this product is modeled on: fixed authored packs make trap-quality and review-specificity possible in a way generated diagnostics cannot; LLM generation remains the engine for the adaptive drills between batches.)
6. **Exercise loop begins (Tally-only phase).** The AIA Academy generates an exercise: a scenario, numbered transactions, and (for later modules) source documents like PDF invoices or a mock bank statement — plus a hidden answer key the tutor generates alongside it. The learner posts the transactions in Tally.
7. **Submission.** The learner uploads their Detailed Day Book XML and Trial Balance XML into the chat. For qualitative modules, they also send an "explain the entry" answer and an open ledger-review answer as separate chat messages, which may arrive out of order over 30–45 minutes.
8. **Validity check.** Before any score is produced, the system checks the upload is the right format (Detailed, not Condensed), complete (all expected transactions present), and readable. If not, it is held and the learner is told exactly what to fix and resubmit — never scored on incomplete data.
9. **Scoring.** Once valid, the parsed submission is scored voucher by voucher against the hidden answer key: account classification, Dr/Cr direction, GST head and rate, TDS section/rate/base, voucher type, bill-by-bill reference, and narration. Trial Balance tie-out is checked. Errors are tagged with internal codes. GST and TDS errors are weighted twice as heavily as narration/discipline errors.
10. **Feedback.** The tutor responds: one plain line stating the result, specific honest praise for what was done well, areas flagged to re-look at (not the exact error, on first pass), a note on whether any previously failed concept is now fixed, still failing, or newly broken, and one line on what's next.
11. **Help ladder (as needed).** If the learner is stuck and asks for help, the tutor climbs a 5-rung ladder — direction, a pointer to a reference video with a guiding question, a simpler analogue problem, the stated rule in plain words, and finally the full worked answer with a check-for-understanding question. It advances one rung per genuine attempt and always eventually resolves.
12. **State update and next exercise.** The learner's mastery map, error history, and hint-rung depth are updated. If a concept has failed 2 of the last 3 attempts, the next exercise drops a level and re-targets that concept. The loop repeats, cycling through modules of rising realism: clean single-concept drills, then traps, then source documents, then a mock bank statement, then open ledger review with seeded anomalies, then judgment/explain questions.
13. **AIA transition.** Once the tutor judges the learner's core accounting mechanics solid (mastery-based, not a fixed module number), it runs an interactive Navattic tour showing how to download the AIA connector and connect it to Tally.
14. **AIA-assisted exercise loop.** The same style of exercises continues, but instead of manually entering bills and statements in Tally, the learner processes them through AIA (extraction, categorization, sync to Tally). They still export and upload the same Detailed Day Book XML and Trial Balance XML, and grading still runs on that same standard.
15. **Capstone.** A full messy client month, handed over the way a real client would hand it over — mixed documents, some messiness, a review section — plus a re-run of the original diagnostic to measure improvement.
16. **Certificate.** Issued on capstone completion.

## Features (by Category)

### Onboarding & Access

- Account creation via Supabase Auth (Google OAuth, magic link)
- One-time Tally license mode capture (`licensed` | `educational`) with plain-language disclosure for Educational Mode
- Books Begin Date confirmation
- Export how-to reference, sendable on request in-chat

### Dashboard

- Landing screen shown after onboarding, two entry points: Modules and Task
- Modules box: placeholder for v1 (5–6 video slots reserved, no functional content — real video library is a later phase)
- Task box: the only functional path in v1, opens the chat shell

### The Live Tutor (Chat)

- Chat interface as the primary learning surface
- In-chat guided walkthrough before the first exercise (Educational Mode disclosure, submission instructions), stepped through via Next → Next → "I understand"
- Exercise generation on demand for adaptive drills (scenario + hidden answer key generated together); diagnostic and capstone use authored packs with authored answer keys
- **Free-form Q&A**: the learner can ask the tutor questions at any time ("which ledger does a background-check payment go to?", "how do I invoice two GST rates on one bill?"), answered grounded in the House Practices Rulebook, the training module reference docs, and the current exercise context — never revealing the active exercise's answer key (Decision 2026-08-19; this was the most-used interaction in the live pilot program)
- Graduated 5-rung hint ladder with anti-gaming (probes for explanation before crediting mastery on suspiciously clean answers)
- Two-lane tone: sharp/Socratic for work coaching, warmer for reflection prompts — never collapsed
- Reference-video pointers by concept tag and timestamp

### Submission & Scoring

- Detailed Day Book XML + Trial Balance XML upload
- Multi-part, out-of-order submission tracking (daybook, explain, review arriving as separate messages)
- Pre-scoring validity gate (format, completeness, readability) — holds and requests resubmission rather than guessing a score
- Voucher-level scoring engine (account, Dr/Cr, GST, TDS, voucher type, bill reference, narration)
- Trial Balance tie-out check
- Error-code tagging with GST/TDS weighted 2x
- Qualitative scoring (recall, precision, reasoning) for explain-the-entry and ledger-review answers

### Mastery & Progression

- Per-concept mastery tracking (3 consecutive clean applications at 90%+, no narration/bill misses)
- Rectification tracking (FIXED / STILL FAILING / NEW on re-tested concepts)
- Reinforcement loop (2-of-3 failures drops a level and re-targets)
- Escalation mode (3 failures triggers slower, more-scaffolded teaching)
- Hint-rung depth as a mastery signal (heavy reliance on rungs 4–5 blocks mastery credit even if the final answer was correct)

### Content Generation

- Authored exercise packs for diagnostic (and capstone): source-file sets (xlsx registers, bank statement, opening TB) + hand-authored answer keys, seeded per variant (A/B). Real reference content now exists: `Karbon_VA_House_Practices_Rulebook_v0.2.docx` and 8 training-module docs (Sales, Purchase, Bank, TDS, GST, Fixed Assets, Payables, Receivables, Journal) — these replace the placeholder Rulebook grounding and the "video slot" placeholders as the tutor's reference material
- Scenario and transaction generation for adaptive drills, calibrated by difficulty (L0–L4)
- Source-document generation (PDF invoices/bills, mock bank statements) with seeded source-integrity traps
- Seeded ledger anomalies for open review, drawn from an anomaly library, with clean distractors
- Variant seeding (name/amount/state variation) to reduce answer reuse

### AIA Integration

- Navattic interactive tour: AIA connector download and Tally connection
- AIA-assisted exercise variants (same scoring standard, different input method)

### Platform

- Learner state persistence (mastery map, error history, hint usage, submission log, reflections)
- Progress view showing module position and flagged escalation concepts
- Certificate issuance
- Background/durable job handling for delayed multi-part submissions and reinforcement checks
- LLM call tracing (Langfuse) and structured-output validation (Zod) between the model and the application

## In Scope (v1)

- Single learner per account, self-serve, no human reviewer in the loop
- Full onboarding and license-mode gate
- Diagnostic exercise (placement, and later re-run at capstone)
- Modules 0–12 (setup through explain/judgment), Tally-graded throughout
- Full coaching engine: hint ladder, Socratic feedback, two-lane tone, anti-gaming
- Full assessment engine: pre-scoring gate, voucher-level scoring, Trial Balance tie-out, qualitative scoring
- Mastery, reinforcement, and escalation logic
- Exercise and source-document generation (scenarios, PDF invoices, mock bank statements, seeded anomalies)
- AIA transition (Navattic tour) and AIA-assisted exercise modules, mastery-triggered rather than a fixed module number
- Capstone module and certificate issuance
- Full technical stack for v1: Next.js, TypeScript, Supabase (DB, Auth, Storage), OpenRouter as LLM provider, Langfuse tracing, Zod schema validation, background job processing (Inngest/Trigger.dev), XML parsing, PDF generation, automated testing, CI/CD

## Out of Scope (v1)

- CA-firm / multi-org / cohort layer (trainer accounts, admin dashboard, cohort rollups, per-trainer visibility controls) — Phase 3
- Configurable house rules per firm (Rulebook stays fixed to Karbon's standard for v1)
- Full anti-copy variant generation at cohort scale — v1 uses lightweight variant seeding only
- Clerk or any third-party identity provider — Supabase Auth only for v1
- Sentry / application crash monitoring
- Localization (Hindi/regional language support) — Phase 4
- Deeper native AIA workflow modules beyond what the current AIA integration supports — Phase 2
- Human reviewer fallback or escalation to a live person
- Reference video production (the tool treats videos as referenceable slots with concept tags and timestamps; producing the actual video content is a separate content-team workstream, not part of this build)

## Success Criteria

The v1 build is done when:

1. A learner can go from sign-up through onboarding, diagnostic, the full Module 0–12 sequence, the AIA transition, AIA-assisted modules, and the capstone, entirely self-serve, with no manual intervention required.
2. A submitted Tally export (Detailed Day Book XML + Trial Balance XML) is reliably parsed into a structured voucher representation and scored against a generated answer key without manual correction.
3. An invalid or incomplete submission is always caught by the pre-scoring gate and never silently scored.
4. The hint ladder never leaves a learner permanently stuck: every "I'm stuck" path eventually reaches rung 5 (full answer) if the learner keeps engaging.
5. Mastery state (per-concept mastery, error history, hint usage, submission log) persists correctly across sessions and correctly drives exercise generation and reinforcement decisions.
6. A concept that failed once and is later fixed is correctly classified as FIXED, and a concept that recurs is correctly classified as STILL FAILING or NEW, both in learner-facing feedback and in stored state.
7. The AIA transition triggers based on the tutor's mastery judgment (not a fixed module number) and AIA-assisted exercises are graded on the same Tally-export standard as manual ones.
8. The learner completes the capstone, sees a diagnostic re-run showing measurable improvement over their original diagnostic score, and receives a certificate.
9. All model-to-application communication (scoring results, exercises, coaching turns, state patches) is validated against strict schemas, with learner-facing prose kept fully separate from machine fields in what the UI renders.
10. The full stack (Next.js, TypeScript, Supabase, OpenRouter, Langfuse, background jobs, XML parsing, PDF generation, tests, CI/CD) is deployed and operating end to end, with Sentry as the only explicitly deferred piece.
