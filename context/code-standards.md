# Code Standards

This document exists so unit 5 and unit 20 look like they were written by the same person. It defines the concrete conventions every unit must follow — not preferences, rules. If code doesn't follow these, it is not done, regardless of whether it works.

## 1. TypeScript Conventions

1. `strict: true` in `tsconfig.json`, no exceptions. Never weaken strictness to make a unit compile faster.
2. No `any`. If a type is genuinely unknown (e.g. raw LLM JSON before validation), type it as `unknown` and narrow it through the Zod schema — never cast through `any` to skip the type system.
3. No `as` type assertions to force a mismatch quiet. If a cast is unavoidable (e.g. a third-party type gap), it must be a narrow, commented, single-purpose cast — not a blanket `as SomeBigType`.
4. Every LLM-facing and DB-facing type is derived from its Zod schema via `z.infer<typeof Schema>` — never hand-write a parallel interface that can drift from the schema that actually validates the data.
5. Use `type` for data shapes (props, DTOs, schema-derived types). Use `interface` only when defining a contract meant to be extended (rare in this codebase — most things aren't).
6. No enums. Use `as const` string unions (e.g. `type LicenseMode = 'licensed' | 'educational'`) — they serialize cleanly to/from JSON and Postgres without extra mapping.
7. Exhaustiveness: any `switch` over a union (voucher type, error code category, hint rung) must have a `default: assertNever(x)` guard so an unhandled case is a compile error, not a silent fallthrough.
8. No `null` and `undefined` used interchangeably for the same meaning. Pick one per field and be consistent: `undefined` for "not yet provided," `null` for "explicitly cleared/absent." Document which, in the schema comment, if it's not obvious.

## 2. Framework Patterns (Next.js App Router)

9. Server Components by default. Add `'use client'` only when a file genuinely needs interactivity (state, event handlers, effects) — not preemptively.
10. Data fetching happens in Server Components or Server Actions, never in a `useEffect` fetch-on-mount pattern. This app has no case where client-side polling is the right default.
11. Mutations (submission upload, hint request, exercise generation trigger) go through Server Actions or `/app/api` routes — never a direct client-side Supabase write from a Client Component, even though the Supabase client technically allows it. This keeps the ownership/validation logic in one place, not duplicated between client and server.
12. Route Handlers (`/app/api/**/route.ts`) are for: webhook receivers (Inngest/Trigger.dev callbacks), and any endpoint that needs to be called from outside the Next.js request lifecycle. Everything else uses Server Actions.
13. No business logic inside `page.tsx` or `route.ts` files. These are entry points only — they parse the request, call into `/lib`, and shape the response. Scoring, parsing, mastery logic, and prompt construction never live in a route file.
14. Loading and error states are explicit per route (`loading.tsx`, `error.tsx`) — do not rely on a single global spinner/error boundary for routes with meaningfully different loading needs (e.g. chat vs. progress view).

## 3. API Route / Server Action Structure

15. Every Server Action and Route Handler follows this shape, in this order:
    1. Parse and validate input (Zod schema for the input, not just the LLM output).
    2. Authenticate/authorize (confirm `auth.uid()` matches the resource being acted on — do not rely on RLS alone at this layer for actions that also trigger side effects like jobs).
    3. Call into `/lib` for the actual logic. The action itself contains no business logic.
    4. Return a typed result or throw a typed error — never return `any` or an untyped object literal.
16. Naming: Server Actions live beside the route that uses them as `actions.ts` (e.g. `/app/(chat)/actions.ts`), one file per route segment, not one giant `actions.ts` for the whole app.
17. Route Handlers are named for the resource, not the verb: `/api/submissions/route.ts` handles POST for creating a submission, not `/api/create-submission/route.ts`.
18. Every mutation that triggers a background job returns immediately with a job/status reference, not a blocking wait for the job to finish. The client polls or subscribes for the result — a Server Action must never block on a multi-minute job.

## 4. File Organization

19. Follow the folder ownership defined in `architecture.md` Section 2 exactly. Do not create new top-level folders under `/lib` or `/app` without updating `architecture.md` in the same change.
20. One export's primary concern per file. `score-submission.ts` scores; it does not also define the scoring Zod schema (`schemas/scoring.ts`) or the DB query that saves the result (`db/queries/scoring.ts`).
21. Colocate a component with its route if it is used only there (`/app/(chat)/components/MessageBubble.tsx`). Promote it to `/components` only once a second route needs it — do not pre-emptively generalize.
22. Test files sit beside the file they test: `mastery.ts` → `mastery.test.ts`, in the same folder. No separate parallel `/tests` tree mirroring `/lib`.
23. Barrel files (`index.ts` re-exporting a folder) are allowed only in `/lib/schemas` and `/lib/db/queries`, where consumers need a stable single import point. Do not add barrel files elsewhere — they hide real dependency structure.

## 5. Styling Conventions

24. Tailwind CSS, utility classes in JSX. No CSS Modules, no styled-components, no inline `style={}` objects except for values that are genuinely dynamic and can't be a class (e.g. a computed progress-bar width).
25. No arbitrary Tailwind values (`w-[137px]`, `text-[15px]`) unless matching a specific, documented design constraint. Use the theme scale. If the scale doesn't have what's needed, extend `tailwind.config` deliberately, don't reach for a one-off bracket value.
26. Shared design tokens (colors, spacing, type scale) are defined once in `tailwind.config.ts`. No hard-coded hex colors or pixel values scattered in component files.
27. Class ordering is left to Prettier's Tailwind plugin — run it, don't hand-order classes for "style."
28. Conditional classes use a `cn()` helper (clsx + tailwind-merge), never manual string concatenation or template-literal class building.

## 6. Component Patterns

29. Props are typed with an explicit `type ComponentNameProps = { ... }`, not inline destructured types, once there are more than two props.
30. No default exports for components. Named exports only — it keeps refactors and imports grep-able and prevents naming drift between the file and the import site.
31. Components that render learner-facing chat content (feedback, hints, exercise prompts) must render only the `prose`/text fields from the validated schema — never interpolate raw LLM output that hasn't passed Zod validation, and never render a field the schema marks as internal (e.g. answer key, error codes meant for logs).
32. Presentational components (pure rendering, no data fetching) are separated from container components (fetch/mutate + compose). A component that calls a Server Action and a component that renders a bubble of text are not the same file.
33. Lists render with stable, meaningful keys (submission ID, exercise ID) — never array index, since chat/history lists reorder and update.
34. Every interactive element (hint button, upload control, submit) has a visible loading/disabled state while its action is in flight — no dead-click windows where a second click could double-submit.

## 7. Cross-Cutting Rule

35. When this document doesn't cover a situation a unit runs into, the agent must not invent a new pattern silently. Propose the pattern, get it confirmed, and add it to this document in the same change — so unit 21 doesn't have to guess again.