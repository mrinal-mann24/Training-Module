# Unit 03: Onboarding (License Mode + Books Begin Date)

## Goal

A logged-in learner who hasn't onboarded yet is shown a two-question onboarding flow (Tally license mode, Books Begin Date confirmation), their answers persist to the database, and they're never shown onboarding again once complete. A learner who has already onboarded skips straight past it. This is the first real data-model unit — first table, first RLS policy actually enforced.

## Design

Reference `context/ui-context.md` — same card/button/token conventions as the login screen from Unit 02, so onboarding feels continuous with it, not a different app.

- Two-step flow on one screen (not a multi-page wizard) — this is two questions, not a long form:
  1. **License mode**: two selectable cards or a segmented control — "Licensed Tally" vs. "Educational Mode." Selecting Educational Mode reveals a plain-language disclosure line beneath it (per `project-overview.md` Step 2: dates are restricted to 1st, 2nd, and last day of any month in this mode) — shown inline, not in a modal.
  2. **Books Begin Date**: a date confirmation, defaulting to 01-Apr-2026 per the spec, editable.
- Single "Continue" button, `accent` background, disabled until both fields have a value.
- On submit, redirect straight into the dashboard (which stays the Unit 02 placeholder for now — no chat yet, that's Unit 04).

## Implementation

### Database
- Create `learner_profile` table: `id` (uuid, references `auth.users`), `license_mode` (`'licensed' | 'educational'`, not nullable), `books_begin_date` (date, not nullable), `onboarded_at` (timestamp, set on completion), `created_at`.
- RLS policy: learner can `select`/`insert`/`update` only their own row (`auth.uid() = id`). This is the first table in the project — confirm the policy is actually applied and tested, not just written, per `architecture.md` Section 4.
- Add this as a new Supabase migration file under `/supabase/migrations` — do not hand-edit the database outside a migration.

### Types and schema
- Define the `LicenseMode` type as an `as const` string union in a shared types location (not an enum), per `code-standards.md` rule 6.
- Define a Zod schema for the onboarding form input (`license_mode`, `books_begin_date`) under `/lib/schemas/onboarding.ts` — this validates the Server Action input, not an LLM output, but the same "validate before it touches app logic" discipline applies.

### Onboarding gate
- On any protected route, check whether the logged-in learner has a `learner_profile` row with `onboarded_at` set. If not, redirect to `/onboarding`. If they do, `/onboarding` itself redirects them away (don't let an onboarded learner re-submit and silently overwrite their answers).
- This check belongs in `/lib/db/queries/learner-profile.ts`, called from the relevant Server Components/middleware — not duplicated inline in multiple routes.

### Onboarding UI and Server Action
- `/onboarding` route, Server Component shell + Client Component for the interactive form (selection state, date picker).
- Server Action validates input against the Zod schema, authorizes (`auth.uid()` matches the row being written), inserts/updates `learner_profile`, sets `onboarded_at`, then redirects to the dashboard.
- No client-side direct Supabase writes — the form submits through the Server Action, per `code-standards.md` rule 11.

## Dependencies

No new packages needed — Supabase client and Zod (already introduced in Units 02 and here for the first time as project convention, but no new install if Zod's already in `package.json`; add it now if it genuinely isn't yet).

## Verify when done

- [ ] A newly signed-up learner is redirected to `/onboarding` automatically after login, before seeing any dashboard content
- [ ] Selecting Educational Mode shows the plain-language date-restriction disclosure inline; selecting Licensed does not
- [ ] "Continue" is disabled until both license mode and Books Begin Date have values
- [ ] Submitting writes a correct `learner_profile` row with `onboarded_at` set
- [ ] After onboarding, visiting `/onboarding` again redirects away instead of re-showing the form
- [ ] Logging out and back in does not re-trigger onboarding for an already-onboarded learner
- [ ] RLS is confirmed working: attempting to read/write another learner's `learner_profile` row fails (test this directly, don't assume the policy is correct because it compiles)
- [ ] Server Action rejects invalid input (e.g. missing license mode) via the Zod schema, not a silent failure
- [ ] No client-side direct Supabase write exists for this form
- [ ] UI uses only `ui-context.md` tokens, consistent with the Unit 02 login screen
- [ ] `npm run build` passes with no TypeScript errors