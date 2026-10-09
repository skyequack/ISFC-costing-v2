# UI_PORT — how to port the legacy UI without redesign
Rule: visual equivalence with `legacy/app.html`. Keep terminology (e.g. "Activity Log", "Cost Settings"), classes, inline styles, structure. Exceptions require a DECISIONS.md row (D-41 wording tweaks are **pending user confirmation** — do not apply).

## 1. Legacy UI facts (verify in file)
- Two `<style>` blocks (lines 8–448): system font stack `-apple-system,"Segoe UI",Roboto,Arial`, 14px/1.5; **no webfont**, **no responsive breakpoints** (only `@media print` at ~312 and ~441); sidebar fixed 230px; RTL only via `dir="rtl"` on `.bt-ar` (2587). Do not use `next/font`, do not add breakpoints.
- CSS has bare element selectors (`table, th, nav button, aside, main, input[type=text], *{margin:0}`) and ids (`#app, #view, #login`). Keep `legacy.css` verbatim in `app/globals.css` and keep the `<aside>/<nav>/<main id="app">` structure so the cascade is unchanged. Wrap Clerk components in a scoped container and style them with Clerk's `appearance` API using the legacy variables so legacy rules don't leak/break them. CSS modules only for genuinely new screens (Users, Menu editor), composed from legacy classes (`.card, .tw, table, .pill, .btn, .chk, .rolebar, .note, .selbar`, modal, plan-table styles `mealhead, daytot, warnrow, tr.on`).
- Render model: `render()` replaces `#view` wholesale, then `enforce()` and `syncPrintTarget()`; search re-renders and restores caret via `focusQ`. 195 inline `onclick`, 52 `oninput/onchange`, 47 `data-perm`.
- One toast (2.2 s; 8 s with action button) and one modal (`.modal.on>.box>h3/.bd/.ft`, Esc or backdrop closes, no focus trap/ARIA, no unsaved-changes guard — `dirty` unused). `window.scrollTo(0,0)` on navigation. Sticky `.selbar` at `top:64px`; sticky `th` in `.tw.h`.
- Brand colours computed in JS (`palette()`/`brandVars()`) → CSS custom properties consumed by `.card>h3, th, tbody tr:hover, .rchead, .pc *`.

## 2. Component strategy
- Shell (Phase 1, real, reused everywhere): sidebar, brand chip, auth bar, header (`#ttl`, `#tsub`, `#acts` slot via portal), `#prthead` & `#printcard` mounts, Toast and Modal **contexts mounted in the layout** (one dialog, one toast), `<Perm perm>` + `usePerm()` reproducing `enforce()` exactly (hide BUTTON/LABEL, disable-and-`.locked` others, title "Locked for your role"), permission set passed from the server in the first paint (no hydration mismatch).
- `<Modal>`: portal to `body`, same markup, add `role="dialog" aria-modal`, focus trap, focus return, Esc/backdrop — accessibility without pixel change (existing `input:focus` style only).
- Screens = JSX with identical classes/inline styles; mind whitespace between inline-block elements when replacing template literals (verify by screenshot). No `esc/escJs` (JSX escapes). `onclick` → handlers calling API routes/server actions; replace global `let` state with local state/URL state.
- Lists (Items 60/page, Recipes 50/page; page-button rule: show first, last, and pages with `|p-page|<4`): server page loads a lightweight DTO (no photos) once; a client component filters/pages in memory so typing never remounts the input or hits the server. No virtualization (page-size parity + print-the-screen prints the whole table).
- Server vs client: Server Components only for Dash, Audit, Health, Settings-read; every screen with filters/selection/modals/forms is a server page feeding a client component (Items, Recipes, Brands, Conv, Yields, Plan, Prod, Prep, Req, Backup, Users, Edit).
- Unsaved changes: match legacy (none); optional accessibility-only enhancement later.

## 3. Print
`lib/print/{card,prep,prod,store}.ts` are pure functions returning HTML strings (port `buildCardHTML`, `prepDoc`, `prodDoc`, `prodSheetSection`, `prodSheetStore`, `cardDocument`). Keep `window.open`/Blob/`print()` timing and download fallbacks. `print.css` is ONE file imported globally **and** as a raw string for blob documents (legacy copied the live page's `<style>` tags; hashed Next CSS would break that). In-page card printing: client `<PrintHost>` rendered as a sibling of the app root; toggle `body.hascard` / `body.previewcard` in effects. No `react-to-print`, no server PDF.

## 4. Port order
Shell + Brands (palette) → Dash → Items → Recipes → Edit/Locked + card print → Conv → Plan + Menu editor → Prod → Req → Prep → Yields → Settings → Audit → Health → Backup → Users. Users and Menu-editor screens last, built only from proven primitives. Screen→legacy-function map: FUNCTION_MAP.md.

## 5. Verification
docs/TESTING.md §5 (visual baselines). Gate: every screen under the pixel threshold; new screens reviewed by eye.
