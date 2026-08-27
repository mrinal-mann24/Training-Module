# UI Context

Design direction: dark/light, friendly, minimal, chat-interface-first (ChatGPT/Claude-style shell). Accent color is inherited from the AI Accountant brand system (`#314DD0`) — this product does not introduce new brand colors; it builds a chat-appropriate neutral system around the existing accent.

**Phase 4 update (2026-08-27, manager direction):** LIGHT is the default theme — the init script only applies dark when the user has explicitly stored a dark choice (OS-level dark preference no longer flips it; existing users who toggled dark keep their choice). The learning surfaces are widescreen: chat messages, composer, and the progress page all live in a centered `max-w-[1150px]` column. Progress framing is concept-area graduation: green "Mastered" badge for consistently-correct areas, amber "Keep iterating" for escalation-active or latest-attempt-failed areas, neutral "Developing" otherwise.

## Color Tokens

### Neutral scale (shared base for both modes)

| Token | Hex | Use |
|---|---|---|
| `neutral-0` | `#FFFFFF` | Pure white — light mode canvas |
| `neutral-50` | `#F7F7F8` | Light mode surface (message bubbles, cards) |
| `neutral-100` | `#ECECEE` | Light mode subtle fill (hover states, chips) |
| `neutral-200` | `#DEDEE2` | Light mode borders |
| `neutral-400` | `#9A9AA2` | Muted text, placeholder, disabled |
| `neutral-600` | `#5C5C64` | Secondary text |
| `neutral-800` | `#232326` | Primary text (light mode) |
| `neutral-900` | `#141416` | Dark mode canvas |
| `neutral-950` | `#0B0B0C` | Dark mode deepest surface (rarely used) |

### Semantic tokens — Light mode

| Token | Hex | Maps to | Use |
|---|---|---|---|
| `bg-canvas` | `#FFFFFF` | `neutral-0` | App background |
| `bg-surface` | `#F7F7F8` | `neutral-50` | Chat panels, cards, tutor message bubble |
| `bg-surface-raised` | `#FFFFFF` | `neutral-0` | Modals, dropdowns (separated by shadow, not fill) |
| `bg-user-bubble` | `#EEF1FC` | tint of accent | Learner's own chat messages |
| `border-default` | `#DEDEE2` | `neutral-200` | Dividers, input borders, card edges |
| `border-subtle` | `#ECECEE` | `neutral-100` | Low-emphasis separators |
| `text-primary` | `#232326` | `neutral-800` | Body text, headings |
| `text-secondary` | `#5C5C64` | `neutral-600` | Timestamps, labels, helper text |
| `text-muted` | `#9A9AA2` | `neutral-400` | Placeholder, disabled, empty states |
| `accent` | `#314DD0` | brand | Primary buttons, links, active states, "thinking" indicator |
| `accent-hover` | `#2A41B8` | darkened accent | Hover/active state on accent elements |
| `accent-subtle` | `#EEF1FC` | tint of accent | Selected row, badge background, subtle highlight |

### Semantic tokens — Dark mode

| Token | Hex | Maps to | Use |
|---|---|---|---|
| `bg-canvas` | `#141416` | `neutral-900` | App background |
| `bg-surface` | `#1C1C1F` | between 900/950 | Chat panels, tutor message bubble |
| `bg-surface-raised` | `#232326` | `neutral-800` | Modals, dropdowns |
| `bg-user-bubble` | `#22284A` | dark accent tint | Learner's own chat messages |
| `border-default` | `#2E2E33` | — | Dividers, input borders |
| `border-subtle` | `#242427` | — | Low-emphasis separators |
| `text-primary` | `#F2F2F3` | near-white | Body text, headings |
| `text-secondary` | `#A6A6AD` | — | Timestamps, labels |
| `text-muted` | `#6E6E76` | — | Placeholder, disabled |
| `accent` | `#5D74E0` | lightened brand accent | Buttons, links — lightened so it holds AA contrast on dark surfaces |
| `accent-hover` | `#7086E6` | — | Hover/active state |
| `accent-subtle` | `#1D2440` | — | Selected row, badge background |

### Status colors (both modes)

| Token | Hex | Use |
|---|---|---|
| `status-success` | `#1F9254` | Passed exercise, mastered concept, correct entry |
| `status-warning` | `#B7791F` | Partial score, "re-look at this," escalation flag |
| `status-error` | `#D0342C` | Failed check, TB mismatch, invalid submission |
| `status-info` | `#314DD0` | Same as accent, reused deliberately — not a competing hue |

## Typography

| Role | Typeface | Notes |
|---|---|---|
| UI / body | Helvetica Neue (brand) | Fallback: `"Helvetica Neue", Helvetica, Arial, sans-serif` |
| Chat message text | Helvetica Neue, Regular | Looser leading than brand default (140%, not 132%) for paragraph-length tutor feedback |
| Numbers / ledger data / XML snippets | `ui-monospace, "SF Mono", "JetBrains Mono", monospace` | Dr/Cr amounts, ledger names, raw XML — prevents digit-alignment ambiguity |
| Weights | Regular (400), Medium (500), Bold (700) | Per brand — no light/thin weights |

### Type scale

| Token | Size / Line height | Use |
|---|---|---|
| `text-xs` | 12px / 16px | Timestamps, badges |
| `text-sm` | 14px / 20px | Secondary text, labels |
| `text-base` | 15px / 22px | Chat message body |
| `text-lg` | 18px / 26px | Section headings within chat (e.g. "Exercise 4") |
| `text-xl` | 22px / 28px | Page-level headings (progress view, onboarding) |
| `text-2xl` | 28px / 34px | Landing/marketing surfaces only — not used inside the app shell |

## Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `radius-sm` | 6px | Badges, chips, inline tags |
| `radius-md` | 10px | Buttons, inputs, small cards |
| `radius-lg` | 16px | Chat message bubbles |
| `radius-xl` | 20px | Modals, large cards, the composer/input box |
| `radius-full` | 9999px | Avatar, pill buttons, status dots |

## AI / Accent Variants

| Token | Light | Dark | Use |
|---|---|---|---|
| `ai-thinking` | `#314DD0` @ 60% opacity, pulsing | `#5D74E0` @ 60% opacity, pulsing | Typing/generating indicator while the tutor composes a response |
| `ai-hint-rung` | `accent-subtle` bg, `accent` text | dark equivalents | Hint ladder rung indicator — same look at every rung, deliberately not an escalating red/yellow/green ramp |
| `mastery-badge` | `status-success` bg tint, `status-success` text | same | "Concept mastered" tag in progress view |
| `escalation-badge` | `status-warning` bg tint, `status-warning` text | same | Escalation-mode flag in progress view |

## Design Notes

- The AI-thinking indicator, links, and primary buttons intentionally share one accent color rather than giving the AI tutor its own separate "assistant color." The tutor is the product, not a bolted-on feature, so it doesn't get a visual identity distinct from the brand's primary action color.
- Radius is rounder here than the marketing brand's sharper geometry — soft bubble shapes read as "friendly" in a chat surface. This is a deliberate divergence for the app shell specifically, not a brand change.
- Hint ladder styling stays visually flat across all 5 rungs on purpose — the ladder is a support mechanism, not a penalty system, and shouldn't look increasingly alarming as a learner needs more help.