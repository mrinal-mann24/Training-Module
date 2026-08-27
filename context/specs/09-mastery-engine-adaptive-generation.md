# Unit 09: Mastery Engine + Adaptive Exercise Generation

## Goal

After a submission is scored, the learner's per-concept mastery state updates, and the next exercise is generated targeting whatever they're actually weak on — not the fixed diagnostic anymore. Reinforcement (2-of-3 failures drops a level and re-targets) and escalation (3 failures) kick in. This is the unit where the product stops being "everyone gets the same thing" and becomes genuinely adaptive.

**Confirmed design constraint:** the learner works in **one single persistent Tally company for their entire journey** (confirmed, may change later — if it does, this unit's company-awareness logic is what needs revisiting first). This means exercise generation can never treat exercises as independent — every new exercise has to be generated with awareness of what's already been posted in that company, so it doesn't invent a colliding ledger/party name or contradict an existing opening balance.

## Design

No major new UI. Progress signals stay inline in chat, not a separate screen (that's Unit 12) — e.g. a small label on the exercise message showing current module/level ("Module 3 · Level 2"), using existing token styles, nothing new.

## Implementation

### Data model

- **`concept_attempts`** (append-only log, never mutated): `id`, `learner_id`, `exercise_id`, `concept_tag`, `result` (`'pass' | 'fail'`), `hint_rungs_used` (int, from Unit 08's `getHintDepthForExercise`), `created_at`. This is the raw history everything else derives from.
- **`concept_mastery`** (materialized summary, one row per learner per concept, updated only by the recompute job — never written directly elsewhere, per `architecture.md` invariant 5): `learner_id`, `concept_tag`, `status` (`'not_started' | 'developing' | 'mastered'`), `consecutive_clean_count`, `last_attempt_result`, `escalation_active` (boolean), `updated_at`.
- **`company_ledger_registry`**: `learner_id`, `ledger_name`, `ledger_type`, `first_used_exercise_id`, `created_at`. Every ledger/party name the exercise generator has ever introduced into the learner's company, so future exercises can either reuse an existing name (realistic continuity) or guarantee a new name doesn't collide.
- **`company_transaction_log`**: `learner_id`, `exercise_id`, `voucher_summary` (jsonb — a compact summary, not the full answer key, of what was posted: voucher type, ledgers touched, amount, date). This is the accumulated history the generator references — foundational for this unit, and for later anomaly-seeding/ledger-review modules (10–11) that need to point back at real prior transactions rather than synthetic ones.
- RLS on all four tables: learner-scoped, standard convention.

### Mastery recompute logic

- `/lib/tutor/mastery.ts`: pure functions, no LLM call, no direct DB writes from outside this file's designated update path (invariant 5).
- Mastery criteria (per `project-overview.md`): a concept becomes `'mastered'` after 3 consecutive clean applications at 90%+, with no narration or bill-reference misses.
- **"Clean" now factors in hint usage**, using Unit 08's rung data for the first time: if the average hint rung used on an exercise exceeds a defined threshold (e.g. rung 4+), that attempt does not count toward the mastery streak even if the final score passed — heavy reliance on late-rung hints means the concept isn't actually internalized yet. Define this threshold as a named constant, not a magic number.
- Reinforcement: if a concept has failed 2 of its last 3 attempts (from `concept_attempts`), the next exercise targeting that concept drops one difficulty level and re-targets it directly.
- Escalation: 3 failures (not necessarily consecutive — check the actual rule against `project-overview.md`'s intent, likely 3 total recent failures) sets `escalation_active: true` — slower pacing, more scaffolding in the next exercise's generation prompt. This flag is what Unit 12's progress view will surface later; this unit just needs to set it correctly.

### `state-patch.ts` schema
- `/lib/schemas/state-patch.ts`: Zod schema for what the recompute step produces — `concept_mastery_deltas` (array of `{ concept_tag, new_status, consecutive_clean_count }`), `escalation_changes`. This is applied to `concept_mastery` as the one sanctioned write path.

### Wiring into the pipeline
- Extend Unit 07's Inngest function: after `scoring_results` is persisted, add a step that appends to `concept_attempts` (per concept covered by the exercise) and runs `mastery.ts`'s recompute, applying the resulting `state-patch` to `concept_mastery`.
- After recompute, trigger next-exercise generation automatically (same auto-delivery pattern as the diagnostic in Unit 04) — the learner doesn't have to ask for the next exercise, it appears once feedback is delivered, consistent with the described flow.

### Adaptive exercise generation
- Extend `/lib/tutor/generate-exercise.ts` (from Unit 04, currently diagnostic-only): add a mode that takes the learner's current `concept_mastery` state, picks a target weak concept (lowest-status concept not yet mastered, or the reinforcement/escalation target if one is active), and generates an exercise at the appropriate difficulty level.
- **Company-aware generation:** before generating, fetch the learner's `company_ledger_registry` and a recent slice of `company_transaction_log`. Include this in the generation prompt so the LLM either reuses an existing ledger/party name where realistic or introduces a genuinely new one — never regenerates a name that already exists in the company with different characteristics (e.g. don't invent a second "Parekh Integrated Services Pvt Ltd" with a different GSTIN).
- After generation, write the new ledger names (if any) to `company_ledger_registry` and the exercise's transaction summary to `company_transaction_log` once the exercise is delivered — this is what keeps the registry accurate for the *next* generation call.

## Dependencies

No new packages — built on Units 04, 06, 07, and 08's existing LLM/Zod/Langfuse/job infrastructure.

## Verify when done

- [ ] After the diagnostic is scored, the next exercise generated is no longer the fixed diagnostic — it targets an actual weak concept from the diagnostic's results
- [ ] A concept mastery status correctly reaches `'mastered'` only after 3 consecutive clean passes at 90%+ with no narration/bill misses — test by simulating exactly this sequence
- [ ] An attempt that passed but used heavy rung 4/5 hints does **not** count toward the mastery streak — test this specifically, it's easy to miss
- [ ] 2 of the last 3 attempts on a concept failing correctly triggers a level-drop and re-target on the next exercise for that concept
- [ ] 3 failures correctly sets `escalation_active: true`, and the next generated exercise's prompt reflects slower/more-scaffolded instructions
- [ ] `concept_mastery` is only ever written by the recompute path in `mastery.ts` — grep the codebase to confirm no other write path exists
- [ ] A newly generated exercise never reintroduces a ledger/party name already in `company_ledger_registry` with conflicting details — test across at least 3–4 generated exercises in sequence to confirm continuity holds
- [ ] `company_transaction_log` accumulates correctly across multiple exercises for the same learner
- [ ] All four new tables have RLS confirmed by direct test
- [ ] Next-exercise generation triggers automatically after feedback is delivered, without the learner needing to ask
- [ ] `npm run build` passes with no TypeScript errors
- [ ] No progress-view UI, certificate, or AIA-transition logic exists yet — those are Units 12 and 13