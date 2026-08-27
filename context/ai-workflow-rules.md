# AI Workflow Rules

These are rules, not suggestions. Follow them exactly. If a rule and a request conflict, follow the rule and flag the conflict instead of silently picking one.

## 1. Overall Approach

1. This project is spec-driven. `project-overview.md` and `architecture.md` are the source of truth for product behavior and system design. Before writing any code, read both. If a task isn't covered by them, do not invent behavior — stop and ask (see Section 4).
2. Build incrementally, in vertical slices. A unit of work is a feature working end-to-end (UI → API → business logic → database/storage → back to UI), not a horizontal layer (e.g. "the whole schema" or "the whole parser") built in isolation.
3. Do not build ahead of the current unit. If you notice a future need while working on the current one, note it in a comment or a TODO list, do not build it now.
4. The riskiest, least-proven parts of this system are the LLM JSON contracts (`/lib/schemas`) and the scoring pipeline. When in doubt about build order, prove these first with a single real worked example before generalizing.

## 2. Scoping Rules

5. Work on exactly one unit at a time, as defined by the current task or ticket. A unit is done when it is fully working and verified (Section 7), not when it "looks right."
6. Do not make speculative changes — no refactors, renames, abstractions, or "while I'm in here" fixes outside the scope of the current unit, even if they seem like improvements. Propose them separately instead.
7. Do not add configuration options, feature flags, or extensibility points that nothing in the current spec asks for. Build what is specified, not what might be needed later.
8. Do not touch files outside the folder(s) the current unit owns, as defined in `architecture.md` Section 2, unless the unit explicitly requires a cross-boundary change (e.g. a new DB migration for a new feature). If it does, say so explicitly before making the change.

## 3. When to Split Work Into Smaller Steps

9. If a unit touches more than one of: database schema, LLM schema/prompt, background job, and UI — split it into separate steps, each independently verifiable, even if they land in the same session.
10. If a task requires a new Zod schema contract between the LLM and the app, treat "define and validate the schema" as its own step, completed and tested with a real or representative example, before writing the code that consumes it.
11. If a task involves both the pure-Tally flow and the AIA-assisted flow, implement and verify one before starting the other. Do not interleave them in a single change.
12. If you find yourself writing a plan with more than roughly 5 discrete actions, stop and split it into multiple units rather than executing it as one large change.

## 4. Handling Missing or Ambiguous Requirements

13. Do not guess silently. If a requirement is missing, ambiguous, or contradicts `project-overview.md` or `architecture.md`, stop and state the ambiguity plainly before writing code.
14. When you must make an assumption to keep moving, state it explicitly in your response and mark it in the code with a comment (`// ASSUMPTION: ...`) so it is easy to find and revisit.
15. Never resolve ambiguity by picking whichever interpretation is easiest to build. Pick the interpretation that best matches the existing spec and invariants, and say why.
16. Specifically flag any requirement that would touch the hidden-answer-key boundary, RLS/ownership boundary, or mastery-state boundary (Section 6 of `architecture.md`) if there's any doubt about how it should behave — these are the highest-cost places to guess wrong.

## 5. Files That Must Not Be Modified Without Explicit Instruction

17. Do not modify generated or vendored files without explicit instruction, including but not limited to:
    - Generated UI library components (e.g. shadcn/ui components under `/components/ui`, once scaffolded)
    - `/supabase/migrations/*` files that have already been applied — create a new migration instead of editing history
    - Lockfiles (`package-lock.json`, `pnpm-lock.yaml`) — let the package manager write these
    - `.env.example` values beyond adding new keys with placeholder values
    - Any file under a `/generated` or `/gen` directory
18. If a change genuinely requires modifying one of these, state that plainly, explain why, and wait for explicit confirmation before proceeding.

## 6. Keeping Documentation in Sync

19. If a unit of work changes product behavior described in `project-overview.md` (the user flow, scope, or features), update `project-overview.md` in the same change — do not let it drift out of date.
20. If a unit of work changes the stack, folder ownership, storage model, auth model, or invariants described in `architecture.md`, update `architecture.md` in the same change.
21. If a unit of work adds or changes an LLM JSON contract, the schema file in `/lib/schemas` is the documentation — keep its inline comments accurate to what the schema actually validates, not what it validated in an earlier version.
22. Never describe a feature as done in documentation before it is verified (Section 7). Documentation must reflect actual, working state, not intended state.

## 7. Verification Checklist Before Moving to the Next Unit

Before marking any unit complete and moving to the next one, confirm all of the following:

- [ ] The unit works end-to-end for at least one real or representative example (not just "the code compiles").
- [ ] Every new LLM output path is validated against its Zod schema, including a check of what happens on validation failure (bounded retry, no silent fallback).
- [ ] No invariant from `architecture.md` Section 6 has been violated (hidden answer key exposure, unscored-until-valid, LLM output unvalidated, RLS bypass, direct mastery mutation, answer key mutation after creation).
- [ ] New or changed tables have RLS policies scoped to `auth.uid()`, and this has been checked, not assumed.
- [ ] Tests exist for the new logic and pass (Vitest). Scoring, parsing, and mastery-transition logic must have tests, not just UI.
- [ ] Relevant documentation (`project-overview.md`, `architecture.md`, schema comments) has been updated if the unit changed anything they describe.
- [ ] No file outside the unit's declared scope was modified, and if it was, it has been explicitly called out and justified.
- [ ] Any assumption made during the unit (Section 4) has been surfaced, not left buried in a comment only.

If any item is unchecked, the unit is not done. Do not proceed to the next unit until it is.