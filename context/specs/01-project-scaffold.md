# Unit 01: Project Scaffold + Design System

## Goal

Set up a working Next.js (App Router, TypeScript strict) project with Tailwind wired to the exact color, typography, and radius tokens from `ui-context.md`, running locally with light/dark mode toggling correctly. No deployment, no CI, no auth, no data — just a styled, empty shell that proves the design system works.

## Design

Reference `context/ui-context.md` directly — do not invent any color, spacing, or radius value not listed there.

- Implement light and dark mode using the semantic tokens (`bg-canvas`, `bg-surface`, `text-primary`, etc.) — not raw hex values in components. Every token from `ui-context.md`'s Light mode and Dark mode tables must exist as a Tailwind theme color or CSS variable.
- Typography: Helvetica Neue stack for UI text, the monospace stack reserved for future numeric/XML content (not used yet in this unit).
- Border radius scale (`radius-sm` through `radius-full`) must exist as Tailwind theme values, not applied ad hoc.
- Build one placeholder screen only: a centered page with the app name, a short static line of text, and a light/dark mode toggle button. This exists purely to visually confirm the token system renders correctly in both modes — it is not a real feature and won't be reused.

## Implementation

### Project initialization
- Initialize Next.js with App Router, TypeScript, ESLint, Tailwind CSS.
- Enable `strict: true` in `tsconfig.json` per `code-standards.md`.
- Set up the `/app`, `/lib`, `/components` folder structure per `architecture.md` Section 2 (folders can be empty/placeholder except what this unit needs).

### Tailwind theme configuration
- In `tailwind.config.ts`, define the full neutral scale, semantic light/dark tokens, status colors, and radius scale from `ui-context.md` as named theme values (colors and `borderRadius`).
- Do not hardcode any hex value inside a component — every color used must resolve through a theme token.

### Dark mode mechanism
- Implement dark mode via Tailwind's `class` strategy (not `media`), so it can later be a user-controlled toggle rather than only following OS preference.
- Add a small client component with a toggle button that switches the `dark` class on `<html>` and persists the choice (localStorage is fine for this throwaway unit — this is not the real settings system).

### Placeholder screen
- Single route at `/` rendering: app name, one line of static body text using `text-primary`/`text-secondary`, and the toggle button.
- Confirm visually that `bg-canvas`, `bg-surface`, `border-default`, `accent`, and both status-success and status-error colors are all visibly correct in both modes (add a small row of colored swatches with labels for this check — remove before Unit 2 if you prefer, it's just for verification).

### Fonts
- Set up Helvetica Neue with the documented fallback stack as the default `font-sans` in Tailwind config.
- Set up the monospace stack as `font-mono` in Tailwind config (unused visually yet, but configured now since it's a one-line addition alongside the sans setup, not a separate future unit).

## Dependencies

- `next` (latest) — framework
- `typescript` — language
- `tailwindcss`, `postcss`, `autoprefixer` — styling
- `clsx`, `tailwind-merge` — for the `cn()` helper defined in `code-standards.md` (not used meaningfully yet, but establish the helper now since every future component will need it)

No backend, database, auth, or LLM packages in this unit — none of that is needed yet.

## Verify when done

- [ ] `npm run dev` runs locally with no errors
- [ ] `npm run build` passes with no TypeScript errors
- [ ] No console errors or warnings in the browser
- [ ] Every color on the placeholder screen comes from a Tailwind theme token, not a raw hex value (spot-check the JSX)
- [ ] Toggling dark mode switches all surfaces, text, borders, and the accent correctly, matching `ui-context.md`'s Light/Dark tables exactly
- [ ] Border radius tokens are available in Tailwind config and visibly correct on at least one element (the toggle button)
- [ ] Fonts render as Helvetica Neue (or the documented fallback) with no layout shift/FOUC
- [ ] `strict: true` is set in `tsconfig.json`
- [ ] Folder structure matches `architecture.md` Section 2 (empty folders are fine, wrong names are not)
- [ ] No CI/CD, hosting, deployment config, auth, or database code exists in this unit