# Phase 3: Structured Help Flow + Rule Enforcement (manager refinement round, 2026-08-24)

Source: manager's meeting notes ("replace simple hint button with a structured 3-step query response", "dummy module names now", file-validation enforcement) + `AIA_Tally_Training_Tool_Build_Spec_v1` Sections 7.1, 8, 9.2, Appendix A/H.

## Goal

1. **3-step query response replaces the 5-rung hint button flow** (manager's simplification of the spec's 5-rung ladder):
   - Step 1: refer the learner to the relevant video module by name, with one guiding question ("Watch the place-of-supply module. As you do, ask: whose state drives the tax?").
   - Step 2: indirect hint — flag what needs rework without giving the answer.
   - Step 3: direct answer with the full concept explanation in crisp simple language, plus a check-for-understanding question.
   - Advance a step only on a genuine attempt; step 3 counts as heavy help for mastery (concept stays in reinforcement).
2. **Dummy video module registry exists NOW** so the agent can reference modules before any video is recorded: titles + concept tags from spec Appendix H (Create a company; Book a sales invoice; TDS at booking; Customer advance chains; Reconciling to a bank statement; etc.), backed today by the extracted module docs.
3. **Educational Mode date rule enforced end to end**: generated exercises for `educational` learners place ALL transaction dates on the 1st, 2nd, or last day of a month; the one-time disclosure exists (Unit 3); scoring/gate never penalizes a date the mode forced. Licensed learners keep natural dates.
4. **Voucher-type-aware narration scoring**: Payments and Receipts require the bank reference plus the party name in the narration (deterministic check: a reference-like token AND a party-name match against the voucher's ledger names); Journals require a non-trivial "why"; Sales/Purchases stay lenient (presence only, as today).
5. **Error-code taxonomy aligned to the spec** (Appendix A): map existing codes onto E01-E15 / R / O codes where the engine can already detect them; add detectable gaps (E08 threshold, E15 parent group is not detectable from the daybook — mark undetectable codes explicitly rather than pretending).
6. **Validation completeness confirmed**: gate rejects wrong date range (already), empty file (already), missing TB (already); "unanswered qualitative points" hold works via the multi-part wait window (Unit 11) — verify and tighten messages to the meeting's wording.

## Design

- The hint ladder's storage stays (`hint_requests.rung`), reinterpreted 1-3; `determineNextRung` caps at 3; existing rows with rung 4-5 read as step 3 for depth signals.
- Hint prompts rewritten per step; step 1 pulls the module name from the new registry via `CONCEPT_TO_MODULE_DOC`-style mapping extended with Appendix H titles.
- Mastery signal: `CONCEPT_PASS` unaffected; hint-depth gating updates from "rungs 4-5 block clean credit" to "step 3 blocks clean credit".
- Q&A router: a question that is clearly "solve my current exercise item" continues to route into the ladder (existing behavior in the QA prompt), now naming the 3-step flow.
- Educational dates: generation prompt conditional on `tally_license_mode`; gate's date check adds no month-day penalty either mode (it never did — confirm and add a test); pack diagnostic keeps natural dates with an explicit disclosure line for educational learners (authored pack cannot re-date; flagged as accepted limitation).

## Implementation

- `lib/llm/grounding/video-modules.ts` (new): the Appendix H list as `{ id, title, conceptTags }`, referenced by hint step 1 and Q&A.
- `lib/tutor/hint-ladder.ts` + `lib/llm/prompts/hint.ts`: 3-step rewrite.
- `lib/tutor/mastery.ts`: hint-depth threshold update (+ tests).
- `lib/llm/prompts/adaptive-exercise.ts` + `generate-exercise.ts`: license-mode-aware dating (mode passed from profile through the generation path).
- `lib/tutor/score-submission.ts`: narration voucher-type-aware check (+ tests); error-code additions/mapping in `lib/schemas/scoring.ts`.
- Gate message wording pass in `submission-gate.ts`.

## Dependencies

Phases 1-2 land first (same prompt files). No new packages.

## Verify when done

- [ ] First help request returns a video-module pointer by name + guiding question; second an indirect hint; third the full answer + explanation + check question; fourth repeats step 3
- [ ] Step-3-assisted correct postings do not earn clean mastery credit
- [ ] An `educational` learner's generated batch dates all fall on 1st/2nd/last of month; a `licensed` learner's do not cluster that way
- [ ] Payment/Receipt narrations without party name or reference are flagged; Sales narration presence still suffices
- [ ] Error codes in stored results use the aligned taxonomy; undetectable codes documented as such
- [ ] Gate messages match the enforcement list wording (missing TB, wrong date range, empty file, unanswered qualitative parts)
- [ ] Full gates pass (tsc, lint, vitest, build)
