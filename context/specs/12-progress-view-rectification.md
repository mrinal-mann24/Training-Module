# Unit 12: Progress View + Rectification Tracking

## Goal

A learner can open a progress view showing their current module/level, per-concept mastery status, and any active escalation flags. Feedback messages (from Unit 06/09's coaching pipeline) now also state whether a concept touched in this exercise is **FIXED** (previously failed, now passed), **STILL FAILING** (failed again), or **NEW** (failed for the first time) — this is the history-aware feedback piece that Unit 06 explicitly deferred.

**ASSUMPTION — flagging per `ai-workflow-rules.md` rule 14:** Unit 09 tracks mastery per concept but never defined the rule for *module advancement* (when does a learner move from Module 2 to Module 3?). This spec assumes: a learner advances to the next module once every concept tagged to their current module has reached `'mastered'` status and no escalation is active. **Confirm this rule against the original build spec before relying on it** — if module advancement is meant to work differently (e.g. a minimum exercise count, or specific required concepts rather than "all"), this unit's `module_progress` logic needs adjusting.

## Design

Reference `context/ui-context.md`.

- `/progress` route: current module/level shown prominently at the top (e.g. "Module 4 · Level 2"). Below it, a list of concepts grouped by module, each with a status badge using the existing `mastery-badge` (mastered) and `escalation-badge` (escalation active) tokens; concepts not yet mastered and not escalated show a neutral/`text-muted` "developing" state rather than either badge.
- No new visual language beyond what `ui-context.md` already defines for this — those tokens were specified back in the design system precisely for this screen.
- Rectification notes in chat feedback render as a short, plain line within the existing feedback bubble (Unit 06's structure) — e.g. "Good news — the GST classification issue from before is fixed." No new bubble type.

## Implementation

### Module progress data model
- `module_progress` table: `learner_id`, `current_module` (int), `current_level` (int), `updated_at`.
- Advancement logic (per the assumption above) lives in `/lib/tutor/module-progress.ts`, invoked as an additional step in Unit 09's mastery recompute: after applying the state-patch, check whether every concept tagged to `current_module` is now `'mastered'` with no active escalation; if so, increment `current_module`, reset `current_level`. Same invariant discipline as `concept_mastery` — this table is only written through this one path, never ad hoc.

### Rectification classification
- `/lib/tutor/rectification.ts`: pure function, no LLM call. Given a concept touched by the current exercise and its `concept_attempts` history (from Unit 09), classify:
  - **FIXED** — the immediately prior attempt on this concept was a failure, this one passed.
  - **STILL FAILING** — the immediately prior attempt failed, this one failed again.
  - **NEW** — this is the first attempt ever recorded for this concept, and it failed.
  - No classification needed/shown for a concept that simply passed again after already passing before — that's just steady progress, not a rectification event worth calling out.
- Feed this classification into Unit 06's `generate-coaching.ts` as additional structured input (not a new LLM call — extend the existing coaching call's input, since it already produces the feedback text this belongs in).

### Progress page
- `/progress` Server Component: reads `module_progress`, `concept_mastery` (joined/grouped by module — concept-to-module mapping needs to exist somewhere; if it doesn't yet, add a `concept_tag -> module_number` lookup, likely a small static config table or constant map, not a new complex system).
- Renders current module/level, then a grouped list of concepts with the appropriate badge per the Design section.

## Dependencies

No new packages — built entirely on Units 06 and 09's existing data and pipeline.

## Verify when done

- [ ] A concept that failed once and passes cleanly on the next attempt is correctly classified FIXED in the resulting feedback message
- [ ] A concept that fails twice in a row is correctly classified STILL FAILING
- [ ] A concept's first-ever attempt, if it fails, is correctly classified NEW
- [ ] A concept passing twice in a row (no prior failure) produces no rectification note — confirm this doesn't spam every passing result with unnecessary callouts
- [ ] `module_progress.current_module` correctly advances once every concept tagged to the current module reaches `'mastered'` with no active escalation — test with a constructed scenario
- [ ] `/progress` renders current module/level and the correct badge per concept (mastered / escalation / developing), matching `ui-context.md` tokens exactly
- [ ] `module_progress` is only ever written through the one sanctioned path (grep to confirm)
- [ ] `module_progress` and any new concept-to-module mapping table have RLS confirmed where applicable
- [ ] `npm run build` passes with no TypeScript errors
- [ ] **The module-advancement assumption in this spec has been confirmed against the original build spec before this unit is considered done**
