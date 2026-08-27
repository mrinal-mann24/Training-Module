# Unit 02: Auth (Supabase, Email + Password)

## Goal

A person can sign up or log in using an email and password, land on a protected (currently empty) dashboard route, and stay logged in across a page refresh. Logging out returns them to the login screen and the protected route becomes inaccessible. No `learner_profile`, onboarding, or any other data model exists yet — this unit is identity only.

## Design

Reference `context/ui-context.md` — no new colors, spacing, or type choices outside those tokens.

- Login screen: centered card on `bg-canvas`, using `bg-surface-raised` for the card, `radius-xl` (matches the "large card" use in `ui-context.md`), `border-default` for the card edge.
- One form: email + password fields, plus a toggle/link between "Log in" and "Sign up" modes (same form, different submit label and Server Action).
- Buttons use `accent` background, `accent-hover` on hover, `radius-md`.
- On sign-up, if Supabase requires email confirmation, replace the form with a confirmation state ("Check your email to confirm your account") — don't leave the form submittable again without a clear reset action. If email confirmation is disabled on the project, sign-up logs the person in immediately and redirects to the dashboard.
- Inline validation error (wrong password, email already registered, weak password, etc.) shown under the form, not as a browser alert.
- Protected dashboard route for this unit is a bare placeholder: canvas background, "You're logged in" text in `text-primary`, and a "Log out" button. It will be replaced by real onboarding/chat content in later units — don't build anything more than this placeholder.

## Implementation

### Supabase project setup
- Create the Supabase project (if not already created) and add environment variables (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) to `.env.local` and `.env.example` (placeholder values only in the example file, per `ai-workflow-rules.md` rule 17).
- Confirm the Email provider is enabled in Supabase Auth settings (enabled by default). Decide and document whether "Confirm email" is on or off for this project — it changes whether sign-up logs the person in immediately or requires a confirmation click first. This is a dashboard setting, not code, so make sure it's not silently assumed.

### Supabase client setup
- Set up the Supabase client per Next.js App Router conventions: a browser client for Client Components, a server client for Server Components/Actions/Route Handlers, using cookie-based session handling (not localStorage) so auth works correctly with Server Components.
- Place these under `/lib/supabase/` (`client.ts`, `server.ts`) — this is the one addition to `/lib` this unit needs beyond what's in `architecture.md`'s existing folder list.

### Auth routes and flow
- `/login` route: the login screen described above, handling both log in and sign up.
- Email/password sign-up and login go through Supabase Auth's `signUp` and `signInWithPassword`, called from Server Actions — never a direct client-side Supabase write from a Client Component.
- If email confirmation is enabled, the confirmation link lands back through an auth callback route (`/auth/callback` or equivalent) that exchanges the code for a session and redirects to the dashboard.
- Middleware (or route-level check, per whichever the current Next.js App Router auth pattern requires) that protects the dashboard route — unauthenticated access redirects to `/login`, not a blank/broken page.

### Session and logout
- Dashboard route reads the session server-side (Server Component) — do not fetch the session client-side and flash unauthenticated content first.
- "Log out" button triggers a Server Action that calls Supabase's sign-out and redirects to `/login`.

### RLS convention (established now, enforced later)
- No learner-owned tables exist yet in this unit, so there's nothing to apply RLS to directly — but confirm the Supabase project has RLS enabled by default on any table going forward, since `architecture.md` Section 4 requires every learner-owned table scoped to `auth.uid()` starting with the very first one created in Unit 03. Nothing to build here, just don't disable this default.

## Dependencies

- `@supabase/supabase-js` — Supabase client
- `@supabase/ssr` — cookie-based session handling for Next.js App Router

No other new packages — no database schema, no ORM, no job runtime needed yet.

## Verify when done

- [ ] A new person can sign up with email + password and lands on the dashboard (immediately, or after confirming their email, depending on the project's "Confirm email" setting)
- [ ] An existing person can log in with the correct email + password and lands on the dashboard
- [ ] Logging in with a wrong password shows an inline error, not a crash or silent failure
- [ ] Refreshing the dashboard page keeps the person logged in (session persists via cookies, not lost on reload)
- [ ] Visiting the dashboard route while logged out redirects to `/login`, never renders protected content
- [ ] Logging out returns to `/login` and the dashboard is no longer accessible until logging in again
- [ ] No Google OAuth or magic-link sign-in exists anywhere in this unit
- [ ] `.env.example` has placeholder values only; real keys exist only in `.env.local` (not committed)
- [ ] Login screen and dashboard placeholder use only tokens from `ui-context.md` — no raw hex values
- [ ] `npm run build` passes with no TypeScript errors
- [ ] No console errors during the full sign-up/login → dashboard → logout cycle
- [ ] No `learner_profile`, onboarding, or other data-model code was added — that's Unit 03
