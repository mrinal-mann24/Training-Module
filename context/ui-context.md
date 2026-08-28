# UI Context

Design direction (2026-08-28, user direction): **light-only, white, minimal SaaS** — the whole product (landing, auth, dashboard, chat, progress) follows the "Nexora-style" landing spec the user supplied: white canvas, dark charcoal ink, an indigo accent, Instrument Serif display headings (with italic emphasis words), Inter body text, pill buttons, frosted-glass cards over an ambient looping background video on marketing/auth surfaces, and framer-motion fade-up entrances on the landing hero. **Dark mode is removed on purpose** — no `.dark` block, no theme toggle, no theme init script. The previous Wandor theme (Geist/Special Elite, terracotta) and the original blue `#314DD0` are both retired.

## Typography

Fonts load via Google Fonts `<link>` in `app/layout.tsx` (preconnect + one stylesheet: Instrument Serif 400 + italic, Inter 400/500/600).

| Role | Typeface | Tailwind | Notes |
|---|---|---|---|
| Display headings | Instrument Serif | `font-display` | Landing h1 `text-5xl md:text-6xl lg:text-[5rem] leading-[0.95] tracking-tight`; one emphasized word per heading in `<em className="italic">`. Auth cards use `text-4xl`, app dashboard `text-5xl/6xl` |
| UI / body | Inter | `font-sans` / `font-body` (identical) | Weights 400/500/600. Wordmark "✦ AIA Academy" is Inter `text-xl font-semibold tracking-tight`, NOT the display font |
| Numbers / ledger data / XML | `ui-monospace, "SF Mono", "JetBrains Mono", monospace` | `font-mono` | Unchanged |

## Color System

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

- **Landing page** (`app/page.tsx`): `h-screen flex flex-col bg-background overflow-hidden` — Navbar + Hero fill exactly 100vh, the dashboard preview clips at the bottom.
- **Navbar** (`app/components/Navbar.tsx`): `px-6 md:px-12 lg:px-20 py-5`, wordmark left, nav links (`text-sm text-muted-foreground hover:text-foreground`, hidden on mobile) + "Get started" pill right.
- **Hero** (`app/components/Hero.tsx`, client): fullscreen background video (`VideoBackdrop`, CloudFront mp4), z-10 content column; framer-motion fade-ups (badge y:10 0.5s → headline y:16 0.6s d0.1 → sub d0.2 → CTAs d0.3 → preview y:30 0.8s d0.5). Badge: rounded-full bordered chip "Now with AI Accountant integration ✨". CTAs: primary pill "Start training" + white circular Play button (`shadow-[0_2px_12px_rgba(0,0,0,0.08)]`, lucide Play `fill-foreground`).
- **Dashboard preview** (`app/components/DashboardPreview.tsx`): fully coded mock, NOT an image — frosted wrapper (`rounded-2xl`, inline `rgba(255,255,255,0.4)` bg, `rgba(255,255,255,0.5)` border, `var(--shadow-dashboard)`), internals `text-[11px] select-none pointer-events-none`. Content mocks THIS product (2026-08-28 user request, replacing the spec's fintech mock): top bar (logo "A" box, search ⌘K, "Start Exercise" primary pill, bell, avatar "ES"), w-40 sidebar (Home active, Tutor Chat badge 2, Exercises, Submissions, Progress, Modules, Certificate + Concepts section: GST/TDS/Bank Entries/Narrations/Settings), main content on `bg-secondary/30` with greeting "Welcome, Elina", action pills (Start Exercise = accent; Upload Day Book / Upload Trial Balance / Ask Tutor / Get a Hint / View Progress), Mastery Score card (92.4%, "+8 passed" green / "2 to retry" amber, hand-crafted cubic-Bézier SVG area chart, accent stroke 1.5 + 15%→0 gradient fill), Concept Areas card (GST Postings 96% / TDS Sections 88% / Bank Reconciliation 74%), Recent Submissions table (Batch 7 Scoring amber, Batch 6 96% green Passed, Batch 5, Batch 4).
- **Auth glass card** (login/onboarding): `rounded-2xl backdrop-blur-xl` with inline `rgba(255,255,255,0.7)` bg + `rgba(255,255,255,0.5)` border + `var(--shadow-dashboard)`, Instrument Serif heading with an italic word, over the shared `VideoBackdrop` in `app/(auth)/layout.tsx`.
- **Button** (`app/components/ui/button.tsx`): shadcn-style, no cva — variants default (bg-primary), ghost, outline; sizes default `h-11 px-6`, icon `h-11 w-11`; `buttonVariants()` helper for styling `<Link>`s.
- **Inputs**: `rounded-lg border-border bg-background px-4 py-2.5 text-sm`, focus = `border-ring` + `ring-1 ring-ring` (indigo).
- **App dashboard cards**: `rounded-2xl border-border`, uppercase micro-eyebrow (accent for the active Task card), Instrument Serif card titles, `bg-primary` arrow circle, hover lift + `shadow-dashboard`.

## Layout

- Landing: exactly 100vh, no scroll (`overflow-hidden` clips the preview).
- Auth: `min-h-svh` over the video, card centered.
- Chat/progress (untouched): centered `max-w-[1150px]` widescreen column; they inherit fonts/tokens automatically.
- Progress framing (unchanged): green "Mastered", amber "Keep iterating", neutral "Developing".

## Design Notes

- One accent: indigo `239 84% 67%` for interactive emphasis; primary actions are charcoal-black pills. No terracotta, no old blue.
- `suppressHydrationWarning` sits on `<html>` and `<body>` in `app/layout.tsx` on purpose (browser extensions inject attributes pre-hydration); do not remove it.
- The hint ladder stays visually flat across steps (support mechanism, not a penalty ramp).
- No em dashes in learner-facing copy (manager spec hard rule) — applies to marketing copy too.
- `tailwindcss-animate` deliberately NOT installed: nothing uses its classes (framer-motion owns animation) and it is a Tailwind v3 plugin; this project is on v4.
