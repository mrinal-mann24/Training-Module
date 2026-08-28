# UI Context

Design direction (2026-08-27, user direction): **light-only, white, minimal, classy** — the whole product (landing, auth, dashboard, chat, progress) follows the "Wandor" landing-page design language the user supplied: white canvas, near-black ink, a warm terracotta accent, pill buttons, generous rounded cards, and a frosted-glass treatment over an ambient looping background video on marketing/auth surfaces. **Dark mode is removed on purpose** — there is no `.dark` block, no theme toggle, no theme init script. The previous AI Accountant blue accent (`#314DD0`) is retired from the UI.

## Typography

Fonts load via Google Fonts `<link>` tags in `app/layout.tsx` (preconnect + one stylesheet: Special Elite 400, Geist 400/500/600/700).

| Role                        | Typeface                                               | Tailwind       | Notes                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UI / body / headlines       | Geist                                                  | `font-sans`    | Weights 400/500/600/700. Headlines are Geist Medium with tight tracking (`tracking-[-0.04em]`), e.g. `text-[clamp(40px,6vw,68px)]` on the landing hero |
| Wordmark only               | Special Elite (typewriter serif)                       | `font-display` | Lowercase wordmark "AIA Academy", 40px on the landing nav, 32px elsewhere. Never used for body text                                                    |
| Numbers / ledger data / XML | `ui-monospace, "SF Mono", "JetBrains Mono", monospace` | `font-mono`    | Unchanged                                                                                                                                              |

Type scale tokens (`text-xs` … `text-2xl`) are unchanged from before; marketing surfaces additionally use arbitrary clamp sizes.

## Color System

### Wandor palette (Tailwind `wandor.*` keys)

| Token           | Hex       | Use                                                                                                                      |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `wandor-dark`   | `#0a0a0a` | Primary/pill buttons, black CTA circles                                                                                  |
| `wandor-text`   | `#1a1a1a` | Headlines, body ink                                                                                                      |
| `wandor-muted`  | `#767676` | Subtitles, secondary marketing text, muted labels                                                                        |
| `wandor-prompt` | `#905831` | Terracotta accent: prompt text in the glass card, links ("Sign up" toggle), the Task card eyebrow, Educational Mode note |

Button hover is `#333` (`hover:bg-[#333]`); pill buttons use `active:scale-95`.

### Semantic CSS-variable tokens (single light theme, `app/globals.css`)

| Token                 | Hex                    | Use                                                                        |
| --------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `--bg-canvas`         | `#ffffff`              | App background                                                             |
| `--bg-surface`        | `#f7f7f6`              | Cards, tutor message bubble (warm near-white)                              |
| `--bg-surface-raised` | `#ffffff`              | Modals, dropdowns                                                          |
| `--bg-user-bubble`    | `#f4efe9`              | Learner's chat messages (warm sand tint of the terracotta)                 |
| `--border-default`    | `#e4e2df`              | Dividers, input borders, card edges                                        |
| `--border-subtle`     | `#efedeb`              | Low-emphasis separators                                                    |
| `--text-primary`      | `#1a1a1a`              | Body text, headings                                                        |
| `--text-secondary`    | `#6b6b6b`              | Timestamps, labels (kept a step darker than `wandor-muted` for AA at 14px) |
| `--text-muted`        | `#9a9a97`              | Placeholder, disabled, empty states                                        |
| `--accent`            | `#0a0a0a`              | Primary buttons, links, active states (black, not blue)                    |
| `--accent-hover`      | `#333333`              | Hover on accent elements                                                   |
| `--accent-subtle`     | `#f4efe9`              | Selected row, badge background                                             |
| `--ai-thinking`       | `rgb(144 88 49 / 60%)` | Typing/generating indicator (terracotta pulse)                             |

### Status colors (unchanged semantics)

| Token            | Hex       | Use                                                     |
| ---------------- | --------- | ------------------------------------------------------- |
| `status-success` | `#1F9254` | Passed exercise, mastered concept                       |
| `status-warning` | `#B7791F` | Partial score, "keep iterating"                         |
| `status-error`   | `#D0342C` | Failed check, TB mismatch, invalid submission           |
| `status-info`    | `#905831` | Aligned to the terracotta accent (was the retired blue) |

## Signature Components

- **Background video + white fade** (`app/components/VideoBackdrop.tsx`): absolutely positioned looping muted video (`object-cover`, z-0) with a 687px white→transparent top gradient (z-1). Used by the landing hero and the `(auth)` layout so login/onboarding share the landing's look.
- **Liquid glass card**: `bg-white/[0.06–0.55] border-[3px] border-white rounded-[44px] backdrop-blur-[20px] shadow-[0_0_4px_0_rgba(0,0,0,0.15)]`. The landing prompt card uses the low-opacity fill; auth cards use `bg-white/[0.55]` for form legibility. Inputs inside glass cards: `rounded-2xl border-white/80 bg-white/75 backdrop-blur-[14px]`, focus ring = `focus:border-wandor-dark`.
- **Pill buttons**: `rounded-full bg-wandor-dark text-[#fafafa] text-[15px] font-medium uppercase tracking-[0.04em] px-5 py-3.5 hover:bg-[#333] active:scale-95`. Secondary/outline variant: transparent with `border-border-default`.
- **Nav**: `max-w-[1360px]` container, `px-20 pt-6 pb-4` (mobile `px-6 pt-5`), wordmark left, uppercase 15px nav buttons center (hidden on mobile), Login + pill CTA right.
- **Dashboard cards**: `rounded-[32px]` large cards, eyebrow uppercase micro-label, Geist Medium title, black circle arrow CTA with hover lift.

## Border Radius Scale

`radius-sm` 6px · `radius-md` 10px · `radius-lg` 16px · `radius-xl` 20px · full 9999px (unchanged), plus marketing radii: `rounded-[32px]` dashboard cards, `rounded-[44px]` glass cards and card CTAs.

## Layout

- Landing/auth: full-viewport `min-h-svh` sections over the video backdrop.
- Chat/progress (unchanged): centered `max-w-[1150px]` widescreen column; they inherit the new fonts/tokens automatically.
- Progress framing (unchanged): green "Mastered", amber "Keep iterating", neutral "Developing".

## Design Notes

- One accent story: black for actions, terracotta for warmth/emphasis. No competing hues; the retired blue must not come back.
- The hint ladder stays visually flat across steps (support mechanism, not a penalty ramp).
- No em dashes in learner-facing copy (manager spec hard rule) — this applies to marketing copy too.
