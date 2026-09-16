# UI Context

Design direction — **one surface, one product** (2026-09-16):

- **Day surface everywhere.** Landing, auth, dashboard, chat and progress
  all render on the day surface. The product's former **white surface**
  (2026-08-28: white canvas, indigo accent, Instrument Serif display, Inter
  body) was retired on 2026-09-16; see "Retired: white surface" below.
- **Day surface origin (2026-09-15, user direction).** Built first for the
  landing page and the auth shell, and rebuilt in the visual and motion language of finance-able.com,
  which the user supplied as the reference (layout, type scale, colour roles,
  and interaction timings read out of its Webflow interaction data). Off-white
  `#fcfcfc` ground, `#232323` ink and dark pill nav, Nunito headings and copy,
  Urbanist UI text, one royal-blue accent `#1c76ff`, grey card shells with
  graph-paper panels, soft white bubbles, a three.js hero and scroll-pinned
  scenes. All copy, figures, icons and the 3D scene are AIA Academy's own.
  It replaced the **night surface** (2026-09-03, a Vesper.ai-inspired black
  frame); see "Retired: night surface" below.

**Landing-only exceptions, on purpose.** The three.js hero (`Hero` +
`HeroScene`), the scroll-pinned scenes (`Tracks`, `Journey`, `TutorVoices`)
and the entrance motion presets stay on the landing page. They are
marketing choreography: a signed-in learner opens the dashboard or chat to
work, and a WebGL canvas or a pinned 400svh section there would cost load
time and battery and push the work below the fold. Product routes share the
tokens, type, materials and card pattern, not the scroll theatre.

**Dark mode is still removed on purpose** — no `.dark` block, no theme
toggle, no theme init script. The previous Wandor theme (Geist/Special
Elite, terracotta) and the original blue `#314DD0` remain retired.

## Day surface, 2026-09-15 (product routes since 2026-09-16)

`.day` sits on the root wrapper of every route: `app/page.tsx`, `app/(auth)/layout.tsx`, `app/dashboard/page.tsx`, `app/(progress)/progress/page.tsx` and `ChatShell.tsx`, plus each route's `loading.tsx` and `error.tsx`. Landing components live in `app/components/site/`; every word and figure is in `site-content.ts`.

**Tokens** (values on `:root` in `globals.css` under "Day surface", consumed as Tailwind `day-*` colours): `--day-bg #fcfcfc`, `--day-ink #232323`, `--day-muted #8f8f8f`, `--day-card #f3f3f3`, `--day-soft #f7f7f7`, `--day-line #ececec`, `--day-line-strong #e0e0e0`, `--day-blue #1c76ff` (hover `#0b62e6`), `--day-panel #232323` (nav, footer, open blocks), `--day-grid #eeeeee`. They sit on `:root`, not `.day`: a custom property that points at another resolves where it is declared, so scoping them would leave the utilities empty. Radii: `rounded-card` 2.625rem (card shells), `rounded-panel` 1.75rem (inner panels), `rounded-footer` 1.375rem.

**Type:** Nunito (400/500/600/700) for headings and copy, Urbanist (400/500/600) for nav, buttons, pills and card titles. Fluid ramps: `.day-display` 40 to 72px (hero h1), `.day-heading` 34 to 56px (section h2), `.day-subheading` 28 to 44px, `.day-mega` 48 to 124px (payoff line, voices header, "ARE YOU IN?"), `.day-figure` 68 to 152px (journey), `.day-stat` 48 to 76px, `.day-lede`, `.day-title` (auth card; its `<em>` goes blue, not italic).

**Material classes:** `.day-grid-paper`, `.day-disc`, `.day-bubble` (via `Bubbles`), `.day-navy`, `.day-arc-top`, `.day-beam`, `.day-orb`, `.day-glow`, `.day-rail` (hidden scrollbar), `.day-input`, `.day-choice` (`aria-pressed`), `.day-error`.

**Motion** (`site-motion.ts`), timings read out of the reference's Webflow interaction data: CSS `ease`; entrances are a 0.5s fade plus a 1s transform in 0.2s steps (`headerReveal` scale 0.8 / y 40 / rotateX -90, `riseReveal`, `scaleReveal`, `swipeReveal`, `sliderReveal`), fired once in view. Scroll scenes use `useSectionProgress` (`useScroll` with `start end` / `end start`, spring-smoothed), so a section N viewports tall is pinned from 1/(N+1) to N/(N+1). Reduced motion: `MotionPreference` strips preset transforms; scroll scenes read `useReducedMotion()` and keep cross-fades only; the 3D scene still follows the scroll but never animates on its own. framer-motion remains the animation library; no GSAP.

**Sections, in order** (`app/page.tsx`):
- `SiteNav`: fixed dark pill (max-w-5xl), wordmark, "Learn" dropdown (tracks / concepts / tools), How it works, About, blue Log in; below `md` a panel under the pill.
- `Hero` (400svh, 300svh on phones) + `HeroScene` (three.js, dynamically imported): 21 extruded metal triangle frames (14 on phones) scattered low around a frosted transmission icosahedron with a blue core. Frames gather into a Fibonacci shell over 0.2 to 0.5, the cluster shrinks 0.5 to 0.72, the canvas fades 0.7 to 0.8. Headline lifts out 0.3 to 0.4; "We Make it Practical" rises 0.4 to 0.5, then scales 2x and fades 0.65 to 0.7. Renders only while on screen in a visible tab; no WebGL means no canvas. A blue load line runs until the first frame. Scatter keeps out of the nav band and the headline's column; on phones every frame starts below the headline and the cluster scales to the width.
- `Tracks` (250svh pinned from `md`): `CardCarousel` of six training stages.
- `Journey` (400svh, `-mt-[100svh]` from `md`, so its arched top rises over the pinned tracks): navy field, beam swings -58° to 0° with an orb riding it, three states (Day 1 / 0–12 / 1 Month) handing over at 0.25 to 0.35, 0.35 to 0.65, 0.65 to 0.75; the third sits on the right half.
- `WhySection`: two copy cards around a coded tutor-reply mock labelled "Sample feedback", then four mechanics stats (7 checks, 2× weight, 5 rungs, 3 runs).
- `ConceptGrid`: nine concept tiles; hover, focus or tap swings the disc aside (rotate 60, scale 0.8, x 100) and reveals what the tutor checks.
- `BuiltDifferent`: four numbered blocks with vertical titles; click widens one (flex-basis transition) to show its body; a stacked accordion below `lg`.
- `Categories`: "Concepts" (9) and "Tools" (5) rails on the same `TrainingCard`, each with a "Start practising" button to /login?mode=signup.
- `TutorVoices`: pinned travelling header (110% to -100% of its own width over 0.12 to 0.42), a note that these are samples, then three masonry columns with parallax (outer 400px, middle 200px) from `md` only.
- `FinalCta` ("ARE YOU IN?", "Get started" to /login?mode=signup) and `SiteFooter` (dark rounded card; no social or legal links, because none exist).

**Shared card** (`TrainingCard`): grey `rounded-card` shell, `aspect-video` graph-paper panel with a blue tag pill and one to three glyph discs (positions shared with the dotted connector lines), two white info pills, Urbanist title, optional blue CTA. `CardCarousel`: native scroll-snap rail whose scroll-padding matches its side padding, 3 / 2 / 1 cards across, arrows step one card and disable at either end.

**Auth shell:** `.day` + `Bubbles`, dark pill header with the wordmark and "Back to site"; the login and onboarding cards are a grey `rounded-card` shell around a white `rounded-panel`; `.day-input` fields (h-12, rounded-2xl), blue pill submit, `.day-choice` licence buttons.

**Product pattern (2026-09-16):** the same materials on the signed-in routes.
- **Header:** `ProductHeader` (`app/components/ProductHeader.tsx`), the dark pill with the wordmark and Log out, shared by dashboard, progress and chat so they cannot drift. Chat puts its "Videos" toggle in the children slot, visible below `md` only.
- **Cards:** a grey `rounded-card border-day-line bg-day-card p-2.5` shell around a white `rounded-panel`. The primary action card (dashboard Task) swaps the grey shell for `bg-day-blue`. Placeholder cards (Video library) use a `day-grid-paper` panel and are never links.
- **Headings:** Nunito on the `.day-heading` / `.day-title` ramps, one emphasised `<em>` in blue, not italic. Eyebrows, pills and buttons are Urbanist.
- **Buttons:** inline blue pills (`rounded-full bg-day-blue font-urbanist text-white hover:bg-day-blue-hover`) and white outline pills (`border-day-line bg-white`). `app/components/ui/button.tsx` is left in place but no route uses it any more.

**Content honesty:** the reference sells with prices, salaries, learner counts, employer logos and testimonials. AIA Academy has none, so each slot carries a real mechanic from `project-overview.md`, and the tutor messages are labelled as samples on the page. Keep it that way: no invented numbers, logos or quotes.

**Documented arbitrary values (code-standards rule 25):** `h-[400svh]`, `max-md:h-[300svh]`, `md:h-[250svh]` (pinned scene lengths), `md:-mt-[100svh]` (journey overlap), `mt-[30svh]` (voices gap), `lg:[writing-mode:vertical-rl]` (block titles). They are scroll choreography with no theme-scale equivalent.

## Retired: night surface

The night surface was fully removed on 2026-09-15. Its components (`Hero.tsx`, `Navbar.tsx`, `Stats.tsx`, `VideoBackdrop.tsx`, `landing-motion.ts`, `DashboardPreview.tsx`) were deleted earlier (commit `e5fafdf`), and its CSS (the `.night*` block in `globals.css`) was removed in the same cleanup that retired this section. No route renders it and nothing on disk references it.

## Retired: white surface

The product's white surface (2026-08-28 to 2026-09-16) is no longer rendered by any route. Its tokens (the shadcn set and the legacy chat/progress set below), `font-display` / `font-body` and `button.tsx` are still defined, because deleting them was outside the scope of the re-skin (ai-workflow-rules rule 6). Do not use them in new work; they are recorded below only so a later cleanup knows what it is removing.

## Typography

Fonts load via Google Fonts `<link>` in `app/layout.tsx` (preconnect + one stylesheet: Nunito 400/500/600/700, Urbanist 400/500/600, and the retired Instrument Serif and Inter).

| Role | Typeface | Tailwind | Notes |
|---|---|---|---|
| Headings, copy, chat message text | Nunito | `font-nunito` (also inherited from `.day`) | `.day-heading` (dashboard h1), `.day-title` (progress h1, auth card); one emphasised word in a blue, non-italic `<em>` |
| Nav, buttons, pills, eyebrows, composer chrome | Urbanist | `font-urbanist` | Wordmark included |
| Numbers / ledger data / XML / file names | `ui-monospace, "SF Mono", "JetBrains Mono", monospace` | `font-mono` | Unchanged |
| (retired) display / body | Instrument Serif / Inter | `font-display` / `font-body` | Unused by routes since 2026-09-16 |

## Color System

Routes use the `day-*` colours above. The status colours below keep their meaning. The two token sets after that are retired.

### Retired: shadcn-style tokens (HSL triplets in `globals.css`, consumed as `hsl(var(--token))`)

| Token | Value | Use |
|---|---|---|
| `--background` | `0 0% 100%` | White canvas (`bg-background`) |
| `--foreground` | `210 14% 17%` | Dark charcoal ink (`text-foreground`) |
| `--primary` / `--primary-foreground` | `210 14% 17%` / `0 0% 100%` | Primary pill buttons |
| `--secondary` / `--secondary-foreground` | `0 0% 96%` / `0 0% 9%` | Subtle fills, hover states, sidebar active row |
| `--muted` / `--muted-foreground` | `0 0% 96%` / `184 5% 55%` | Muted fills / secondary text (`text-muted-foreground`) |
| `--accent` / `--accent-foreground` | `239 84% 67%` (indigo ≈ #6366F1) / white | Accent chips, chart stroke/fill, links, selected states, avatar |
| `--border` | `0 0% 90%` | `border-border` everywhere |
| `--ring` | `239 84% 67%` | Focus rings (`focus:border-ring focus:ring-ring`) |
| `--radius` | `0.5rem` | Base radius |
| `--shadow-dashboard` | `0 25px 80px -12px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.06)` | Frosted card shadow; Tailwind `shadow-dashboard` |

Components must use semantic tokens (now the `day-*` set), never raw color values (status colors below are the sanctioned exception set).

### Retired: legacy app tokens (chat/progress)

`--bg-canvas #ffffff`, `--bg-surface #f5f5f5`, `--bg-surface-raised #ffffff`, `--bg-user-bubble #eef2ff` (indigo-50), `--border-default #e5e5e5`, `--border-subtle #f0f0f0`, `--text-primary #252b31`, `--text-secondary #5a6470`, `--text-muted #879192`, `--accent-hover #4f46e5`, `--accent-subtle #eef2ff`, `--ai-thinking rgb(99 102 241 / 60%)` (indigo pulse). Chat and progress restyle themselves through these with zero markup churn. NOTE: Tailwind `accent` is now `hsl(var(--accent))` with a `foreground` sub-key; `text-accent`/`bg-accent` still work in old components.

### Status colors (unchanged semantics)

`status-success #1F9254` · `status-warning #B7791F` · `status-error #D0342C` · `status-info #6366F1` (was aligned to the retired indigo accent; unused by routes).

## Signature Components

- **Wordmark** (`app/components/Wordmark.tsx`): the ✦ glyph redrawn as an inline SVG (`SparkMark`, `fill="currentColor"`) plus "AIA **Academy**", `whitespace-nowrap`. Shared by the landing header and the auth shell. `SparkMark` is reused inside the hero badge.
- **Sign in / sign up** (`app/(auth)/login/`): one route, two modes, **chosen by the URL** (2026-09-16). `/login` is sign in; `/login?mode=signup` is sign up. `page.tsx` reads `searchParams` and renders `<AuthForm key={mode} …>`, so each mode mounts with its own action state. The switch between modes is a real `<Link>`. Every wording difference (heading, blurb, submit label, pending label, the link to the other mode) is declared in one `COPY` record at the top of `AuthForm.tsx`, so neither mode can quietly inherit the other's wording. Sign in: "Welcome *back*" / "Sign in to pick up your next batch where you left it." Sign up: "Start your *first* batch" / "Create an account and your diagnostic exercise is ready to work in Tally."
  - **Telling the modes apart at a glance:** sign in keeps the compact single-panel card (`max-w-md`). Sign up is a wider two-panel card (`max-w-3xl`): a `day-grid-paper` panel with a blue "New account" pill and three numbered `day-disc` steps (create account, tell us your background, first batch opens in Tally) beside the white form panel. The steps stack above the form on phones. Every step is a real part of the flow.
  - **After sign-up** the `signUp` action ends the automatic session and `redirect`s to `/login?created=1`, which shows the "Account created" notice above the sign-in form.
  - **Callback errors:** `/login?error=…` (sent by `app/auth/callback/route.ts`) shows a fixed notice. The query text is never displayed.
  - "Get started" and "Start practising" on the landing page link to sign-up; the "Log in" links go to `/login`.
- **Button** (`app/components/ui/button.tsx`, retired): shadcn-style, no cva. No route uses it since 2026-09-16; buttons are inline day pills.
- **Inputs**: `.day-input` everywhere (auth fields `rounded-2xl`, chat composer `rounded-full h-12`, report-issue textarea `rounded-2xl`); focus is a blue border plus a soft blue ring, defined once in `globals.css`.
- **Dashboard cards** (2026-09-16): the Progress card is a grey shell and white panel linking to /progress; the Task card is the blue shell (the page's one primary action) with a white `day-disc` arrow; the Video library card is a grey shell around a `day-grid-paper` panel, "Coming soon", not a link. Urbanist uppercase eyebrows, Nunito titles.
- **Chat layout** (2026-09-16): `ChatShell` is `.day flex h-dvh flex-col`: `ProductHeader`, then a row of `VideoSidebar` and the chat column (scroll area + `ReportIssue` + `Composer`). `h-dvh`, not `h-screen`, so a phone's browser bars never cover the composer. Turns are spaced `space-y-6`; bubbles are `rounded-panel px-6 py-5 leading-relaxed` in Nunito. Tutor bubbles are `bg-day-card`; learner bubbles are `bg-day-blue` with white text. Chips and pills are Urbanist `rounded-full`.
- **Video sidebar** (`app/(chat)/chat/VideoSidebar.tsx`, 2026-09-16): "Video library" with five tiles (graph-paper thumbnail, play disc, duration pill, title) from `video-sidebar-content.ts`. **Sample content:** there is no video backend yet, so the section says "Sample titles. Videos arrive in a later phase." and every tile carries a "Sample" pill. Tiles are not links or buttons, for the same reason the landing nav items are inert: a control that goes nowhere would be a lie. It is a persistent `w-72` aside from `md`; below `md` it is a drawer opened by "Videos" in the header (`role="dialog"`, closes on Escape, backdrop or close button, focus moves to close). The drawer is `z-40`, under the `z-50` onboarding and report-issue modals.
- **Chat composer (Smart Send, 2026-09-15)** (`app/(chat)/chat/Composer.tsx`): single Send button with context-aware placeholders ("Type your explanation, or ask me a question, then send." / "Type your review of the packet, or ask me a question, then send."). Displays `AnswerConfirmation` (app/(chat)/chat/AnswerConfirmation.tsx) as a tutor bubble for any typed text that is not a clear question (2026-09-16: answers AND unclear text), showing "Send this as your explanation? It will be scored." with "Submit answer" and "It's a question" buttons. No autofocus on confirmation card.
- **Parts checklist** (`SubmissionPartsChecklist.tsx`, fixed 2026-09-16): shown only when the exercise also needs a typed part (explain or review), never on a plain two-file upload. "Daybook ✓ · Trial Balance ✓ · Explanation — waiting". It reads the stored parts once its Realtime channel is live and unions in later inserts, so parts saved before it mounted show ✓ instead of "waiting".
- **Progress bar** (`app/components/ui/ProgressBar.tsx`, 2026-09-16): the only bar in the product. `role="progressbar"` with `aria-valuenow/min/max` and an `aria-label`, `bg-day-line` track and `bg-day-blue` fill (was `bg-secondary` / `bg-accent` before 2026-09-16). Width is an inline style, the case code-standards rule 24 names explicitly. Appears on the dashboard above the two cards ("N% complete · X of 19 concepts", linking to /progress, which had no inbound link before) and at the top of /progress. Mirrored in both `loading.tsx` skeletons.
- **Progress page** (2026-09-16): five named module cards (Sales and Receivables, Purchases and Payables, Banking, GST and TDS, Month End and Assets) replacing nineteen cards titled "Module 1" to "Module 20". Each shows its blurb, an "X of Y" or "Complete" count, and its concepts with the existing `ConceptStatusBadge`. The numbered heading is gone: the chat chip, this page and the dashboard bar all derive their module label from one helper over the same mastery map, which fixes the old split where chat said "Module 3" and this page said "Module 7" for the same learner.
- **Feedback bubble, no verdict** (2026-09-16): the Pass / Partial / "Needs work" badge above the coaching prose is gone, along with every percentage. The bubble opens with one plain line, then "What went well" and "What needs work". The status colours stay in use elsewhere (`ConceptStatusBadge`, the invalid-upload chip); only the batch verdict was removed. The chat chip now reads "GST and TDS · Level 2" rather than "Module 8 · Level 2".
- **Loading and error states (2026-09-15)**: every product route (/chat, /progress, /dashboard) and /onboarding has `loading.tsx` (Server Component skeleton copying the page's layout with `aria-busy="true"`, pulsing placeholders one shade darker than their surface, `motion-safe:animate-pulse` only) and `error.tsx` (Client Component logging in `useEffect`, never showing `error.message`, displaying `error.digest` as a small "Reference code" only when one exists, with "Try again" button calling `retry` and a safe-route link: dashboard for chat/progress, `/` for dashboard, `/login` for onboarding).

## Layout

- Dashboard and progress: `ProductHeader`, then a `max-w-5xl` main column. Chat: header, then the `w-72` video sidebar (from `md`) beside a centred `max-w-[1150px]` message column; the composer spans the chat column only.
- Progress framing (unchanged): green "Mastered", amber "Keep iterating", neutral "Developing". These three are the only judgement the learner sees on their work. The badges are Urbanist `rounded-full` pills; the colours keep the status set, not the blue accent, so "Mastered" never reads as a link.

## Design Notes

- One accent: day blue `#1c76ff` (hover `#0b62e6`) for interactive emphasis and primary pills. No indigo, no terracotta, no old blue.
- The nav items and the hero's "See how it works" are `<button>`s that do nothing yet, on purpose. They are placeholders for sections that do not exist, and a dead `#anchor` would be a worse lie than an inert control.
- `suppressHydrationWarning` sits on `<html>` and `<body>` in `app/layout.tsx` on purpose (browser extensions inject attributes pre-hydration); do not remove it.
- The help ladder stays visually flat across steps (support mechanism, not a penalty ramp). This matters more since 2026-09-16, when a failing batch began pushing a step automatically: help now arrives unasked, so it must not read as a telling-off.
- Nothing the learner sees rates them. No percentage, no mark, no pass/fail. Progress is shown as position (how far through the material) and as concept status (Mastered / Keep iterating / Developing), never as a score.
- No em dashes in learner-facing copy (manager spec hard rule) — applies to marketing copy too.
- `tailwindcss-animate` deliberately NOT installed: nothing uses its classes (framer-motion owns animation) and it is a Tailwind v3 plugin; this project is on v4.
