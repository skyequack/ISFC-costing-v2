# UI_PORT — how to port the legacy UI without redesign
Rule: visual equivalence with `legacy/app.html`. Keep terminology (e.g. "Activity Log", "Cost Settings"), classes, inline styles, structure. Exceptions require a DECISIONS.md row (D-41 resolved: no wording changes except the Backup subtitle — see §7).

## 1. Legacy UI facts (verify in file)
- Two `<style>` blocks (lines 8–448): system font stack `-apple-system,"Segoe UI",Roboto,Arial`, 14px/1.5; **no webfont**, **no responsive breakpoints** (only `@media print` at ~312 and ~441); sidebar fixed 230px; RTL only via `dir="rtl"` on `.bt-ar` (2587). Do not use `next/font`, do not add breakpoints.
- CSS has bare element selectors (`table, th, nav button, aside, main, input[type=text], *{margin:0}`) and ids (`#app, #view, #login`). Keep `legacy.css` verbatim in `app/globals.css` and keep the `<aside>/<nav>/<main id="app">` structure so the cascade is unchanged. (D-53: auth screens may use Clerk UI as-is.) Wrap Clerk components in a scoped container and style them with Clerk's `appearance` API using the legacy variables so legacy rules don't leak/break them. CSS modules only for genuinely new screens (Users, Menu editor), composed from legacy classes (`.card, .tw, table, .pill, .btn, .chk, .rolebar, .note, .selbar`, modal, plan-table styles `mealhead, daytot, warnrow, tr.on`).
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

## 6. Pictures (D-48)
Port these controls with the legacy markup/classes (no redesign):
1. **Recipe card editor — "Dish Photo"** (legacy 3165-3176): `.phbox` (`.has` when a photo exists); empty state `<label class="phadd" data-perm="recipe.edit">` with `＋` / "Add a photo" and a hidden `<input type="file" accept="image/*">`; filled state: `<img>` (click = enlarge modal via the shared Modal), `.phact` with "Replace" (`label.btn.sm.o`), "Remove" (`btn sm d`), and the KB figure (`.phkb`, from `size`). Hidden for roles without `recipe.edit` and on LOCKED cards (editable()).
2. **New recipe card dialog (new):** an optional "Add a photo" using the same `.phbox/.phadd` primitives; uploaded after the card is created. No new CSS.
3. **Add brand (Settings, new):** the legacy inline row (`Brand name` + `Prefix` + `Add`) gains the **Brand logo** box (`.logobox` / `.logoprev` "No logo" / "Choose image" / "Remove logo", same helper text) so the logo is chosen before pressing Add; shown only with `brands.edit`. The brand is created, then the logo uploaded (docs/API.md two-step).
4. **Edit brand modal:** unchanged control (Choose image / Remove logo, "PNG with a transparent background works best…"); the "stored inside this file" sentence is **stale** under D-49 and is a D-41-style wording change — keep verbatim until you confirm the replacement.
Behaviour: client resizes before upload (photo ≤ 760 px JPEG q.72; logo 320 px PNG; SVG rasterised); show legacy toasts ("Processing the photo…", "Photo added · w×h · KB", "That photo could not be used", "That image is over 3 MB - use a smaller one"); previews use object URLs until saved; after save, `<img>` uses `photoUrl`/`logoUrl`. Accessibility: file inputs get labels/aria without visual change.

## 7. Resolved wording and additions (D-41, D-45, D-52, D-31)
- **No label changes** (D-41): "Selling price", "Price at target", etc. stay exactly as legacy. **One factual correction:** Backup subtitle becomes "Your data is stored securely in the database. Download a backup copy at any time." (legacy: "Your data lives in this browser - back it up").
- **Double-waste note (D-45):** in the recipe editor, a small `.note`-style hint under a line whose `y` is not 1 while a waste % is set ("Yield factor and waste % are both set — waste may be counted twice"). Non-blocking; costing unchanged.
- **Brand sites editor (D-52):** inside the existing Edit brand modal, a "Sites" section built from legacy primitives (chips with remove ×, an input + Add button, inline rename). Visible only with `brands.edit` (GM). Removing a site that has stored rows shows the count and is refused; renaming updates stored rows.
- **Audit screen (D-31):** the legacy "Clear activity log" button now adds a marker; a "Show archived" toggle reveals older entries.
- **Price-list import (D-43):** dry-run table shows old/new/Δ%; rows beyond ±20% get a `PRICE CHECK` pill (legacy pill classes).

## 8. As built (2026-10-09)
- Screens are server pages (data via `src/lib/screens/*`) feeding client components in `src/components/screens|recipes|io`. Legacy inline `style="…"` strings are kept verbatim through `s('…')` (`src/components/ui.ts`), so the declarations stay greppable against `legacy/app.html`.
- The editor commits each field on blur/Enter (legacy `onchange`), sends `PATCH` with the card `version`, and adopts the server's recomputed cost; modals share form state through `createStore`/`useStore`.
- Print: the card is `buildCardHTML` (`src/lib/print/card.ts`, D-21 label); blob documents copy the page's same-origin CSS rules and inline images as data URLs at print time. Production/store sheets: `src/lib/print/prod.ts`.
- Not ported on purpose (D-54): the browser-storage notes, *Rebuild from this file*, *Backup including accounts & PINs*, *Reset to factory data*. New screens built only from legacy primitives: Users & Access, the menu editor, the reconciliation table, the import review dialogs.
- Stale PIN / "stored in this file" sentences were rewritten under D-58 (the only wording changes besides the D-41 Backup subtitle).

## 9. Dashboard analytics v2 (D-65…D-67) — new strings and classes
New UI on the Dashboard only; legacy classes reused (`.card .tw .kpis .pill .btn .note .empty .bar`), no new CSS. New strings (approved with D-66): Brand/Site/From/To labels (existing words), Reset, Export analytics, Analytics exported, `Filtered: {brand} · {site} · {from} – {to}` + the sentence saying which sections respond to which filter, Menu Matrix, Stars, Plowhorses, Puzzles, Dogs, Unpopular/Popular high/low margin, Not enough data to classify yet, Not classified: … (incl. "whose cost could not be calculated"), Margin at Risk, Cost Drivers, Unpriced Exposure, Over Target (section), Class, Share, Cumulative. The Dashboard subtitle is unchanged (D-65). The matrix is an HTML grid with clickable `.pill` chips plus a table (prints, keyboard).

### Slice 2a (D-71): Clients and Production
New strings (approved with the plan): Cost Settings card **Clients** with help "Clients belong to a brand. Production can be entered per client, and the Dashboard can be filtered by client.", "Client name", Add client, Deactivate, Reactivate, Remove, Active, Inactive, "No clients yet.", toasts Client added / renamed / deactivated / reactivated / removed. Production: label **Client**, options **All clients**, **Unassigned**; note "Every client is added together here. Pick a client, or Unassigned, above to enter numbers."; tooltip "Pick a client above to enter numbers". Legacy classes only (`.card .tw .pill .btn .rolebar`).
