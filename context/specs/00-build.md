Here's the build broken into units, in order, following those rules. I flagged one blocker inline where it hits the still-open persistent-vs-fresh-company decision.

**1. Project scaffold, design system, CI/CD**
Builds: Next.js (App Router, TS strict), Tailwind wired to `ui-context.md` tokens, Vitest, 
Visible result: a deployed, empty app styled with the real color/type system.
Depends on: nothing.

**2. Auth (Supabase, email + password)**
Builds: Supabase project, base RLS convention, login/signup pages, protected route handling.
Visible result: a learner can sign up, log in, and land on a protected (empty) dashboard.
Depends on: Unit 1.

**3. Onboarding (license mode + Books Begin Date)**
Builds: `learner_profile` table + RLS, onboarding UI, Server Action, skip-if-done logic.
Visible result: a new learner completes onboarding and it persists across sessions.
Depends on: Unit 2.

**4. Chat shell + first LLM-delivered content (diagnostic exercise)**
Builds: chat UI (thread + composer), OpenRouter client wrapper, Langfuse tracing wrapper, first Zod schema (`exercise.ts`), `exercises` table + RLS, the diagnostic exercise delivered through the real generation pathway.
Visible result: a learner sees the diagnostic exercise appear in chat.
Depends on: Unit 3. *(LLM/Zod/Langfuse plumbing introduced here, not earlier — this is the first point anything actually needs it.)*

**5. Submission upload + XML parsing + validity gate**
Builds: Supabase Storage bucket, `submissions` table + RLS, upload UI, `fast-xml-parser` integration (incl. UTF-16LE decoding, confirmed from the real sample files), normalization into voucher structure, pre-scoring validity gate.
Visible result: a learner uploads Daybook + TB XML and sees either "accepted, scoring…" or a specific, actionable rejection message.
Depends on: Unit 4.

**6. Scoring engine + hidden answer key + feedback**
Builds: answer key generated alongside the exercise, `scoring.ts` schema, scoring logic (diffs, error codes, TB tie-out, GST/TDS weighting), coaching/feedback LLM call + schema, `scoring_results` table, Rulebook grounding wired into both the scoring and coaching prompts.
Visible result: the learner gets a real scored result and Socratic feedback message for the diagnostic.
Depends on: Unit 5.

**7. Background jobs (Inngest/Trigger.dev) + durable scoring**
Builds: job runtime setup, webhook route, retrofit Unit 6's scoring call to run as a durable job instead of an inline blocking call, `submissions.status` tracking.
Visible result: scoring survives a page refresh / process restart mid-run — same outcome as Unit 6, now durable.
Depends on: Unit 6. *(Job infra introduced here — first point scoring needs durability, not before.)*

**8. Hint ladder**
Builds: hint-rung schema + logic, "I'm stuck" UI affordance, rung-progression tracking.
Visible result: learner can ask for help mid-exercise and get a rung-appropriate hint that escalates on repeated requests.
Depends on: Unit 6.

**9. Mastery engine + adaptive exercise generation (module loop begins)**
Builds: `mastery_map` schema, `state-patch.ts` schema, mastery recompute job, reinforcement (2-of-3 drop) and escalation (3-fail) logic, exercise generation now targets weak concepts instead of the fixed diagnostic, module progression table.
Visible result: after the diagnostic, the learner gets an adaptively generated Module 1 exercise targeting an actual weak area; repeated failures visibly trigger level-drop/escalation.
Depends on: Unit 7, Unit 8.
**⚠ Blocked on a decision:** whether learners work in one persistent Tally company or a fresh one per module. This changes what "generate an exercise" needs to know (just the target concept, vs. the entire prior transaction history in that company). Needs resolving before this unit starts, not during it.

**10. Source document generation**
Builds: PDF generation (`@react-pdf/renderer`), source-doc generation prompts/schema, PDF storage, exercises can now attach generated invoices/bank statements.
Visible result: an exercise arrives with a real generated vendor invoice PDF the learner works from.
Depends on: Unit 9. *(PDF lib introduced here — first point anything needs it.)*

**11. Qualitative modules: multi-part, out-of-order submissions**
Builds: extends submission model to accept free-text "explain" and "review" messages as separate parts, qualitative scoring schema (recall/precision/reasoning), anomaly seeding library, exercises the wait-for-submission job for the first time with real multi-part timing.
Visible result: a learner completes a ledger-review exercise across 3 separate messages sent over time; all parts aggregate and score together.
Depends on: Unit 10, Unit 7.

**12. Progress view + rectification tracking**
Builds: progress page UI, mastery map display, escalation flag display, FIXED/STILL FAILING/NEW classification in feedback.
Visible result: learner opens a progress view showing real mastery state and module position.
Depends on: Unit 9.

**13. AIA transition + AIA-assisted exercises**
Builds: mastery-based AIA-readiness check, Navattic tour trigger, AIA-assisted exercise generation variant (same schema, different instructions/input method), still scored on the Tally export.
Visible result: a learner who hits AIA-readiness sees the Navattic tour, then receives their first AIA-assisted exercise.
Depends on: Unit 9, Unit 12. *(Navattic introduced here — first point it's needed.)*

**14. Capstone + diagnostic re-run + certificate**
Builds: capstone (full messy month) generation, diagnostic re-run + before/after comparison logic, certificate PDF generation + storage + issuance record.
Visible result: learner completes the capstone, sees a real before/after comparison, downloads a certificate.
Depends on: Unit 13, Unit 10, Unit 12.

That's 14 units, no Sentry, no Clerk — matching what you scoped for v1. Note that Unit 9 is the hard stop: I wouldn't start it until the persistent-vs-fresh-company question is actually answered, since it changes that unit's design, not just its implementation details.