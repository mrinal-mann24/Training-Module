# Phase 1: Feedback Voice and Structure (manager refinement round, 2026-08-24)

Source: manager's meeting notes + the Teams pilot agent's actual messages (the target voice) + `AIA_Tally_Training_Tool_Build_Spec_v1` Section 7.2. This phase makes our feedback read like the pilot agent's: score up front, headed sections, every line teaching something specific.

## Goal

A scored submission's feedback message matches the pilot agent's shape and voice:

1. **Opens with the score**: "Your diagnostic came in at 63%. A solid first pass with real strengths to build on." — one plain line, percentage included, measured framing.
2. **"What went well"** as a headed section with bullet points, each specific and explanatory: "Your TDS is spot on. You deducted on the taxable base every time, not the gross, and picked the right sections and rates." Never generic praise.
3. **"What needs work"** as a headed section with bullets, each tied to a specific voucher/area AND teaching the underlying principle: "When money comes in from a customer, book it to that customer's ledger and tie it to the open invoice, not to a brand new ledger."
4. Rectification note woven in plainly (FIXED / still open / newly slipped — existing Unit 12 signal, plain words).
5. One closing line on what comes next.
6. **No em-dashes anywhere in learner-facing text** (hard rule from the manager spec — colon, comma, or full stop instead). Applies to ALL learner-facing prose: coaching, Q&A answers, hints, batch text, gate messages, composer placeholders, the Day-1 template, ChatShell tutor notes.

## Design

- The score percentage is now learner-visible (reversing the earlier hide-the-number stance — the pilot agent shows it and the manager's screenshots are the standard). Qualitative sub-scores (recall/precision/reasoning) stay hidden as numbers.
- `CoachingSchema` evolves: `{ opening_line, went_well: string[], needs_work: string[], next_note }` replacing `{ result_line, praise, flagged_areas, next_step_note }`. `MessageBubble` renders "What went well" / "What needs work" headings over the bullet lists, using existing type tokens (`text-lg` section labels, normal bullets).
- The coaching prompt is rewritten against the pilot messages as style exemplars (2-3 real excerpts embedded as few-shot voice guides). Each needs-work bullet must state the principle, not just point: "flag the area AND say the rule in one breath" — this stays within the Socratic boundary because the exact fix for the learner's specific entry is still not named on first pass.
- Batch intro line (adaptive generation prompt): the batch must open by naming what it builds on, pilot-style: "Your invoices and TDS were strong, so this batch works on the bank side."

## Implementation

- `lib/schemas/coaching.ts`: new field names; migration of stored `feedback_text` NOT required — old rows keep the old shape; `MessageBubble` + timeline rebuild render whichever shape a row has (a tiny compat mapper in one place).
- `lib/llm/prompts/coaching.ts`: rewrite the writing instructions + embed pilot-voice exemplars; pass `weightedScorePercent` as learner-visible; keep the factual guards (TB attribution, no-invented-facts, missing-parts rules) and the grouped/capped areas signal.
- Em-dash sweep: prompts gain the no-em-dash rule; static learner-facing strings replaced (`ChatShell` tutor notes, gate messages in `submission-gate.ts`, `actions.ts` error strings, Day-1 template in `scripts/seed-pack.mjs` → reseed needed, composer placeholders).
- `checkResultLineFacts` / `composeFallbackResultLine` renamed targets follow the schema rename.

## Dependencies

None new. Reseed the pack after the Day-1 template edit.

## Verify when done

- [ ] A scored submission opens with the percentage and a measured one-liner
- [ ] "What went well" and "What needs work" render as headed bullet sections
- [ ] Each needs-work bullet teaches the principle without naming the learner's exact fix
- [ ] Rectification (FIXED / STILL FAILING) appears as a plain line inside the sections
- [ ] Batch 2+ opens by naming what it builds on
- [ ] grep confirms no em-dash in any learner-facing string or prompt-emitted text instruction
- [ ] Old stored feedback rows still render (compat mapper) — refresh a pre-change conversation
- [ ] Tests updated (coaching schema/guards) and `npm run build` passes
