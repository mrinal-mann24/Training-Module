# UI Context

Design direction — **two surfaces, one product**:

- **Night surface (2026-09-03, user direction): the landing frame and the
  auth shell.** Pure black, white Inter, one Instrument Serif italic phrase
  per heading held back to muted grey, liquid-metal nav pills, liquid-glass
  buttons, a frosted card, film grain, and the ambient hero video underneath
  a scrim. Taken from a Vesper.ai reference the user supplied as *inspiration
  only* — the structure and material language are borrowed, all copy, marks,
  claims and iconography are AIA Academy's own.
- **White surface (2026-08-28 direction): the product.** Dashboard, chat and
  progress keep the light-only, minimal-SaaS theme: white canvas, dark
  charcoal ink, indigo accent, Instrument Serif display headings, Inter body,
  pill buttons.

**Dark mode is still removed on purpose** — no `.dark` block, no theme
toggle, no theme init script. The night surface is a scoped `.night` token
block on a wrapper element, not a second global theme: nothing inside the
app inherits it, and the two surfaces are chosen per route, never per user
preference. The previous Wandor theme (Geist/Special Elite, terracotta) and
the original blue `#314DD0` remain retired.

## Typography

Fonts load via Google Fonts `<link>` in `app/layout.tsx` (preconnect + one stylesheet: Instrument Serif 400 + italic, Inter 400/500/600).

| Role | Typeface | Tailwind | Notes |
|---|---|---|---|
| Display headings | Instrument Serif | `font-display` | App dashboard `text-5xl/6xl`, one emphasized word per heading in `<em className="italic">`. On the night surface the serif is reached only through `.night-headline em` / `.night-title em` — the surrounding heading is Inter 500, and the `<em>` supplies the single serif italic phrase |
| UI / body | Inter | `font-sans` / `font-body` (identical) | Weights 400/500/600. Wordmark "✦ AIA Academy" is Inter `text-xl font-semibold tracking-tight`, NOT the display font |
| Numbers / ledger data / XML | `ui-monospace, "SF Mono", "JetBrains Mono", monospace` | `font-mono` | Unchanged |

## Color System

### Night surface tokens (`.night` scope in `globals.css`)

Scoped to `app/page.tsx` and `app/(auth)/layout.tsx`. `.night` also sets
`color-scheme: dark` so native controls (the onboarding date picker,
scrollbars, autofill) render dark instead of arriving light on black.

| Token / class | Value | Use |
|---|---|---|
| `.night` bg / text | `#000000` / `#ffffff` | The surface |
| `--night-muted` | `#9a9a9a` | Lede, blurbs, the serif `<em>`, unselected choices; class `.night-muted` |
| `--night-stat` | `#d8d8d8` | Stats row |
| `--night-line` | `rgb(255 255 255 / 16%)` | Card, input and choice borders |
| `.night-error` | `#ff9a8f` | Form errors: the app's `--status-error` `#D0342C` is below readable contrast on black |

Type roles are fluid `clamp()` ramps, one rule each, continuous from a 360px
phone to a 2560px display, with no breakpoint stack: `.night-headline`
(34 to 88px, Inter 500, `-0.045em`), `.night-title` (28 to 36px, the auth
card), `.night-lede` (15.5 to 22px), `.night-badge` (12.5 to 14.5px),
`.night-stat` (12.5 to 16px).

Material classes: `.night-pill` (liquid-metal nav pill with a swept
`::before` highlight), `.night-btn` plus `.night-btn-solid` /
`.night-btn-glass` (swept `::after` highlight, painted under the label via
`isolation: isolate` and `z-index: -1`), `.night-badge`, `.night-card`,
`.night-input`, `.night-choice` (selection carried by `aria-pressed`, so
accessible and visual state cannot drift), `.night-menu-backdrop`,
`.night-grain`, `.night-scrim` (phone-only, see VideoBackdrop below),
`.night-page` (the three-row single-viewport frame).

**Blur caveat:** `backdrop-filter` written in plain CSS is dropped by the
Tailwind v4 build. Verified in the browser: the rest of the same rule
applies, that one declaration does not. Frosted surfaces therefore carry
Tailwind's `backdrop-blur-*` utility in the JSX instead. `.night-btn-glass`
takes `backdrop-blur-lg`; `.night-card` and `.night-menu-backdrop` take
`backdrop-blur-xl`. Do not move it back into `globals.css`.

### shadcn-style tokens (HSL triplets in `globals.css`, consumed as `hsl(var(--token))`)

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

Components must use semantic tokens, never raw color values (status colors below are the sanctioned exception set).

### Legacy app tokens (chat/progress) — same vars, repointed values

`--bg-canvas #ffffff`, `--bg-surface #f5f5f5`, `--bg-surface-raised #ffffff`, `--bg-user-bubble #eef2ff` (indigo-50), `--border-default #e5e5e5`, `--border-subtle #f0f0f0`, `--text-primary #252b31`, `--text-secondary #5a6470`, `--text-muted #879192`, `--accent-hover #4f46e5`, `--accent-subtle #eef2ff`, `--ai-thinking rgb(99 102 241 / 60%)` (indigo pulse). Chat and progress restyle themselves through these with zero markup churn. NOTE: Tailwind `accent` is now `hsl(var(--accent))` with a `foreground` sub-key; `text-accent`/`bg-accent` still work in old components.

### Status colors (unchanged semantics)

`status-success #1F9254` · `status-warning #B7791F` · `status-error #D0342C` · `status-info #6366F1` (aligned to the indigo accent).

## Signature Components

- **Landing frame** (`app/page.tsx`, server): `.night .night-page` — a three-row grid (header / hero / stats) that is exactly one viewport with no scroll from `lg` up, and free-flowing below it. `VideoBackdrop` and `.night-grain` sit outside the flow; `MotionPreference` wraps the three rows.
- **Wordmark** (`app/components/Wordmark.tsx`): the ✦ glyph redrawn as an inline SVG (`SparkMark`, `fill="currentColor"`) plus "AIA **Academy**", `whitespace-nowrap`. Shared by the landing header and the auth shell. `SparkMark` is reused inside the hero badge.
- **Navbar** (`app/components/Navbar.tsx`, client): 3-column grid `1fr auto 1fr`, wordmark left, four `.night-pill` nav items centre, "Start for free" solid button + burger right. Every child is pinned with an explicit `col-start-*`: the nav is `display: none` on phones and auto-placement would otherwise pull the CTA into the centre track and crush the wordmark. Nav items are `<button>`s, not `#anchors`, because those marketing sections do not exist yet. Phone menu: full-screen fixed nav over `.night-menu-backdrop`, closed by Escape, a nav tap, the backdrop, or the viewport crossing `lg`; body scroll frozen while open. `justify-self-center` is `lg`-only because Chrome applies it to the fixed menu and shrink-wraps it.
- **Hero** (`app/components/Hero.tsx`, client): bottom-anchored, not vertically centred, so the copy lands on the darkest part of the backdrop. Badge (`.night-badge` + `SparkMark`) → two-line `.night-headline`, each line in its own `overflow-hidden` span so `maskUp` wipes it into view → `.night-lede` → solid "Start training free" (to `/login`) and glass "See how it works". Copy: "Post it in Tally. Get scored / like a *real client* month."
- **Stats** (`app/components/Stats.tsx`, client): the three claims that close the frame, each an inline SVG plus a line — ledger columns / "Every voucher scored: account, Dr/Cr, GST, TDS", a five-rung ladder / "A five-rung hint ladder, so you are never stuck", a checked tile / "Mastery at three clean runs above 90%". These are product mechanics, deliberately **not** adoption numbers: there are no user counts to quote and inventing them would put a false claim on the page.
- **Entrance motion** (`app/components/landing-motion.ts`): one shared staged timeline for the whole frame — logo 0.08, nav 0.16/0.28/0.40/0.52, header CTA 0.34, badge 0.22, headline lines 0.42/0.62, lede 0.82 (1.25s), CTAs 0.96/1.10, stats 1.12/1.28/1.44, all `cubic-bezier(0.16, 1, 0.3, 1)` over 1.05s. Presets `fadeScale` / `fadeUp` / `maskUp` / `pop` / `riseIn` / `slideIn` spread straight onto a `motion.*` element. `MotionPreference` (`MotionConfig reducedMotion="user"`) handles `prefers-reduced-motion` once for everything below it.
- **VideoBackdrop** (`app/components/VideoBackdrop.tsx`): the ambient loop, served from the CloudFront URL the user supplied (`d8j0ntlcm91z4.cloudfront.net/.../hf_20260818_072341_...mp4`, ~9.5 MB, referenced directly rather than vendored into `public/`). It is a near-black field with a soft grey particle ribbon, which is what makes the pure-black surface work. The older local `/videos/hero-bg.{webm,mp4}` pair — the pale "handwritten ledgers to AI city" artwork from the white theme — is no longer referenced but is left in `public/videos` untouched.
  - **Scrim policy:** the clip plays at 100% opacity with **no overlay** on landscape viewports, as specified; the crop keeps the ribbon in the upper third and the copy sits on near-black. In portrait, `object-cover` zooms the 16:9 clip so far in that the ribbon sweeps across the headline and lede and white type disappears into it for part of the loop (seen at 375x812). `.night-scrim` therefore paints **only below `lg`**, bottom-weighted, leaving the top band of artwork visible. At 1512px its computed background is `none`.
- **Dashboard preview** (`app/components/DashboardPreview.tsx`): **currently not mounted anywhere** — the landing hero stopped rendering it before the night-surface work and the new frame has no slot for it. The file is still a fully coded mock, NOT an image — frosted wrapper (`rounded-2xl`, inline `rgba(255,255,255,0.4)` bg, `rgba(255,255,255,0.5)` border, `var(--shadow-dashboard)`), internals `text-[11px] select-none pointer-events-none`. Content mocks THIS product (2026-08-28 user request, replacing the spec's fintech mock): top bar (logo "A" box, search ⌘K, "Start Exercise" primary pill, bell, avatar "ES"), w-40 sidebar (Home active, Tutor Chat badge 2, Exercises, Submissions, Progress, Modules, Certificate + Concepts section: GST/TDS/Bank Entries/Narrations/Settings), main content on `bg-secondary/30` with greeting "Welcome, Elina", action pills (Start Exercise = accent; Upload Day Book / Upload Trial Balance / Ask Tutor / Get a Hint / View Progress), Mastery Score card (92.4%, "+8 passed" green / "2 to retry" amber, hand-crafted cubic-Bézier SVG area chart, accent stroke 1.5 + 15%→0 gradient fill), Concept Areas card (GST Postings 96% / TDS Sections 88% / Bank Reconciliation 74%), Recent Submissions table (Batch 7 Scoring amber, Batch 6 96% green Passed, Batch 5, Batch 4).
- **Auth shell** (`app/(auth)/layout.tsx`): the same `.night` surface, backdrop and wordmark as the landing frame, so arriving from "Start training free" reads as one continuous page. Unlike the landing frame it scrolls, because onboarding is a real form.
- **Auth glass card** (login/onboarding): `.night-card` + `backdrop-blur-xl`, `rounded-2xl p-8`, `.night-title` heading with one serif italic phrase.
- **Sign in / sign up** (`app/(auth)/login/`): one route, two modes. `page.tsx` is only the card; every difference between the modes (heading, blurb, submit label, pending label, the link to the other mode) is declared in one `COPY` record at the top of `AuthForm.tsx`, so neither mode can quietly inherit the other's wording. Sign in: "Welcome *back*" / "Sign in to pick up your next batch where you left it." Sign up: "Start your *first* batch" / "Create an account and your diagnostic exercise is ready to work in Tally."
- **Onboarding form**: `.night-input` fields; the licence-mode pair uses `.night-choice` with `aria-pressed` carrying the selection. This replaced a `cn()` branch on `licenseMode`, so the styling and the accessible state now come from the same attribute.
- **Button** (`app/components/ui/button.tsx`): shadcn-style, no cva — variants default (bg-primary), ghost, outline; sizes default `h-11 px-6`, icon `h-11 w-11`; `buttonVariants()` helper for styling `<Link>`s.
- **Inputs**: app surfaces use `rounded-lg border-border bg-background px-4 py-2.5 text-sm`, focus = `border-ring` + `ring-1 ring-ring` (indigo). The night surface uses `.night-input` (translucent white fill, pale-blue focus ring) plus a `-webkit-autofill` override, since Chrome otherwise repaints autofilled fields near-white.
- **App dashboard cards**: `rounded-2xl border-border`, uppercase micro-eyebrow (accent for the active Task card), Instrument Serif card titles, `bg-primary` arrow circle, hover lift + `shadow-dashboard`.

## Layout

- Landing: `.night-page`, exactly `100svh` with `overflow: hidden` from `lg` up (verified in the browser: zero scroll at 1512x860). Below `lg` it flows and scrolls normally, the hero stacks, the CTAs go full-width and the stats become a centred column.
- Auth: `min-h-svh` over the video, card centered, scrolls.
- Chat/progress (untouched): centered `max-w-[1150px]` widescreen column; they inherit fonts/tokens automatically.
- Progress framing (unchanged): green "Mastered", amber "Keep iterating", neutral "Developing".

## Design Notes

- One accent: indigo `239 84% 67%` for interactive emphasis; primary actions are charcoal-black pills. No terracotta, no old blue. The night surface has **no** accent hue at all: its only colour moves are white, greys, and the faint blue-white bloom in the button hover glows.
- The night surface deliberately makes no claim it cannot support. No user counts, no adoption figures, no logos: every line on it describes a mechanic that `project-overview.md` actually specifies.
- The nav items and the hero's "See how it works" are `<button>`s that do nothing yet, on purpose. They are placeholders for sections that do not exist, and a dead `#anchor` would be a worse lie than an inert control.
- `suppressHydrationWarning` sits on `<html>` and `<body>` in `app/layout.tsx` on purpose (browser extensions inject attributes pre-hydration); do not remove it.
- The hint ladder stays visually flat across steps (support mechanism, not a penalty ramp).
- No em dashes in learner-facing copy (manager spec hard rule) — applies to marketing copy too.
- `tailwindcss-animate` deliberately NOT installed: nothing uses its classes (framer-motion owns animation) and it is a Tailwind v3 plugin; this project is on v4.
