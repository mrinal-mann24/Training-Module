# Phase 2: Batch Depth and the 50/50 Rule (manager refinement round, 2026-08-24)

Source: manager's meeting notes ("current batches too shallow", "10-12 questions with a 50/50 split") + `AIA_Tally_Training_Tool_Build_Spec_v1` Sections 5 and 10.

## Goal

Every generated batch (post-diagnostic) is a substantial, targeted set:

1. **10 to 12 transactions per batch** (current batches produce ~3-6, too shallow — cash-to-bank/bank-to-cash alone is not a batch).
2. **50/50 composition**: roughly half the transactions INCREASE complexity on concepts the learner got right (step-up: same concept, one level harder, new trap layered in), and half DIG DEEPER into concepts they got wrong (reinforcement: cleaner, more scaffolded reps).
3. The batch intro names both halves in plain words (pilot voice, ties into Phase 1): "Your invoices and TDS were strong, so those get harder here. The bank side slipped, so half this batch is receipts and payments matched to the right bills."
4. Difficulty calibration per the spec's ladder: step-up items at learner's level +1 (capped L4); reinforcement items at current level or one below when reinforcement is active.

## Design

- Concept selection becomes two lists, not one target. New pure function `selectBatchConcepts` (replacing single-target use of `selectWeakConcept` for batch generation): from `concept_attempts` + `concept_mastery`, return `{ strengths: ConceptTag[], weaknesses: ConceptTag[] }` — strengths = concepts with recent clean applications (mastered or clean streak ≥ 2); weaknesses = recent failures / reinforcement-active. Cap each list (2-3 concepts per side) so the batch stays coherent, not a survey.
- The adaptive generation prompt receives both lists with explicit instructions: 10-12 numbered transactions total, ~half tagged to strength concepts at raised difficulty, ~half to weakness concepts with scaffolding; every transaction's answer-key `concept_tags` must reflect which side it serves.
- Explain/review cadence (select-exercise-kind) unchanged — an 'explain' batch is this same structure plus the explain part; 'review' unchanged.
- Voucher-count expectations: the gate's `transactions.length` check continues to work naturally (generated exercises list all transactions in chat).

## Implementation

- `lib/tutor/select-batch-concepts.ts` (new, pure, tested): the strengths/weaknesses split with caps; deterministic ordering.
- `lib/tutor/generate-exercise.ts`: `generateAdaptiveExercise` takes the two lists (keeps single-target signature for escalation mode, which deliberately narrows to ONE concept per the spec's escalation rule).
- `lib/llm/prompts/adaptive-exercise.ts`: 10-12 transaction requirement, 50/50 instruction, per-side difficulty guidance, batch-intro naming rule; escalation mode overrides to single-concept scaffolded (existing behavior preserved).
- `lib/jobs/run-scoring.ts`: generate-next-exercise step computes and passes the two lists.
- LLM output size: 10-12 transactions × 2+ legs of answer key comfortably fits existing schema; bump nothing.

## Dependencies

None new. Phase 1's prompt voice work should land first (one prompt file touched by both).

## Verify when done

- [ ] A generated batch contains 10-12 numbered transactions
- [ ] Answer-key concept_tags show both strength-side and weakness-side concepts in roughly even split
- [ ] Batch intro names what got harder and what is being reinforced
- [ ] Escalation mode still produces a single-concept scaffolded exercise (not a 12-item batch)
- [ ] Step-up items sit one level above, reinforcement items at/below current level (inspect generated difficulty + content)
- [ ] `selectBatchConcepts` unit tests cover: fresh learner (few attempts), all-mastered, all-failing, caps
- [ ] Full gates pass (tsc, lint, vitest, build)
