# Phase 4: UI Polish + Content Variety (manager refinement round, 2026-08-24)

Source: manager's meeting notes (widescreen/bright background, concept-area graduation, mock document formats). **Variant B is explicitly REMOVED from this phase's scope by the user (2026-08-24)** — Variant A (Blossom Retail) remains the only diagnostic pack; do not build Variant B seeding, selection stays on the any-pack fallback.

## Goal

1. **Bright, widescreen learning UI**: light background becomes the default theme for the chat (better for a learning context per the manager); the chat column widens for widescreen use. Dark mode stays available via the existing toggle; all existing `ui-context.md` tokens continue to apply.
2. **Concept-area graduation view**: the progress surface frames graduation the manager's way — concept areas consistently correct are marked **green**; areas consistently wrong show as "keep iterating" until strengthened. Graduation is concept-area based, not a flat percentage. A "% complete" indicator is a nice-to-have, not required now.
3. **Mock document format variety**: 5-6 distinct sales-invoice formats and 5-6 purchase-invoice/bill formats, plus a bank-statement format styled like a real bank export (HDFC-style header/columns), so learners see realistic variety instead of one template. Formats rotate across generated documents.

## Design

- Theme default: light-first (`ThemeToggle` default flips; FOUC-safe init respects stored preference, so existing users keep their choice). Body/background/token behavior unchanged otherwise.
- Layout: chat message column max-width increases for widescreen (target ~1100-1200px content width on large screens), composer matches; message bubbles keep current internal styles. Progress page follows the same width.
- Progress view: reuse `concept_mastery` + escalation data. Mastered = `status-success` green treatment (existing mastered badge); failing/reinforcement = "keep iterating" with `status-warning`; developing = neutral. Grouped by concept area (existing module grouping). No new data model.
- Document formats: `lib/documents/templates/` gains format variants per doc type (layout/typography/field-arrangement variations, same data schema). A format key is chosen per generated document (deterministic rotation seeded by exercise id — reproducible, no `Math.random` in render paths). The HDFC-style statement variant mirrors real column order (Date, Narration, Ref/Cheque, Debit, Credit, Balance).
- OUT OF SCOPE (this phase): Variant B (removed by user), certificate, capstone, video production, progress-% meter.

## Implementation

- `app/globals.css` / theme init + `ThemeToggle`: light default.
- `app/(chat)/chat/ChatShell.tsx` + `MessageBubble` container widths; `/progress/page.tsx` width + wording ("keep iterating").
- `lib/documents/templates/`: `vendor-invoice-{a..f}.tsx`-style variants (5-6), `bank-statement-hdfc.tsx` (+ keep the generic one), a `pickTemplate(docType, exerciseId)` selector; `render-source-document.ts` routes through the selector.
- No migration, no schema change.

## Dependencies

Phases 1-3 not blocking, but land Phase 1 first so demo screenshots show the new voice on the new UI. `@react-pdf/renderer` already present.

## Verify when done

- [ ] Fresh visitor gets the light theme by default; toggle still switches and persists; no FOUC/hydration mismatch
- [ ] Chat and progress render comfortably at widescreen widths; no horizontal scroll at any width
- [ ] Progress view shows green for mastered areas and "keep iterating" for failing/reinforcement areas, grouped by concept area
- [ ] Generated documents across several exercises use visibly different formats; same exercise re-render picks the same format (deterministic)
- [ ] HDFC-style statement variant renders with realistic bank columns
- [ ] Confirmed: no Variant B code paths added; pack selection unchanged
- [ ] Full gates pass (tsc, lint, vitest, build)
