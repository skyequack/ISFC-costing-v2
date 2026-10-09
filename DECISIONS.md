# DECISIONS.md — ADR log

Status key: ✅ approved by user · 🟡 default I will implement unless told otherwise · ❓ needs a user decision before the affected slice

| # | Decision | Status |
|---|---|---|
| D-01 | Manager-PIN, user PIN login, `security` object and `resetAccess` are removed. Clerk only. | ✅ |
| D-02 | The GM manages users in an in-app **Users tab**. It writes Clerk `publicMetadata.role` via the Clerk Backend API; brand access lives in `UserBrandAccess`. Legacy protections kept: cannot demote/suspend/delete the last active GM, cannot suspend/delete yourself. | ✅ |
| D-03 | `app.html` = `ISFC_Costing_System_v8.7.html`; frozen copy at `legacy/app.html`. | ✅ |
| D-04 | DB keeps legacy settings names and fractions (`pkg, del, lab, ops, buffer, target, vat`). UI/API map them to spec labels. | 🟡 |
| D-05 | Menu plans are **editable** in V1 (user choice, scope: basic editor). New tables `Menu`/`MenuRow`/`MenuCell` seeded from legacy `MENU_PLAN`; `MenuPax` keys on stable `menuId` instead of array index. GM + Cost Controller can edit (new perm `menu.edit`). `ProductionEntry` as in schema.md. Scope expansion vs spec — approved. | ✅ |
| D-06 | Menu plan/menu builder stay SSEM-only (`bssem`) as legacy. Prep/Production ARE brand-scoped per D-07 (supersedes the old "not gated"). | ✅ |
| D-07 | Brand access limits **everything brand-tied** for non-GM: recipes, dashboard, production, requisition, menus. Shared (unscoped) ingredients visible to all. | ✅ |
| D-08 | Migrate the **final effective state** (`golden/state.json`). Legacy boot migrations and the every-load integrity pass (deleted seed items reappearing, NC rebuild, yield resets) are NOT ported. | 🟡 |
| D-09 | `Float` everywhere; no rounding in storage or calculation; round only at display/export (money 2dp, % 1dp, exports keep ≥6dp for prices). | ✅ |
| D-10 | Costing ported line-for-line. Requisition/production keep `reqExpand` quantity semantics but **valuation applies the same unit conversion as costing**, flags unconvertible lines and truncation at depth 4, and a reconciliation report compares requisition value to portions × card cost (D-28). | ✅ |
| D-11 | Both `y` and `yp` are stored, plus per-card `buffer`. | 🟡 |
| D-12 | Recipe `code` unique case-insensitively; editor and import reject duplicates with the clashing code named. | ✅ |
| D-13 | Editor/API **blocks saving** a line that would create a cycle; cost engine keeps `circular` detection as safety net. | ✅ |
| D-14 | Soft delete (`deletedAt`) replaces `deletedCards`; undo restores. | 🟡 |
| D-15 | Audit: append-only, no 600 cap, no Signed in/out, no HTML-escape at write. Existing actions kept **plus** brand add/edit/logo, settings changes (old→new), recipe create/edit. | ✅ |
| D-16 | Server guards: `settings.edit` (GM + Finance, as legacy; audited old→new with count of cards affected); brand add/edit/delete → `brands.edit` (GM); export endpoints → `export`; `users.manage`, `data.admin`, `brands.edit` are GM-only and declared in the central permission type; `menu.edit` → GM + Cost Controller. | ✅ |
| D-17 | Export/import add `Waste %` (yp) and `Card buffer` columns; old files without them import leaving those values untouched. | ✅ |
| D-18 | `doBulkLock` crash: implement intended behavior (lock selected, one audit entry). | 🟡 |
| D-19 | Production CSV: implement intended columns (legacy throws). | 🟡 |
| D-20 | "All sites" = sum of all sites + unassigned bucket on both Prep and Production (Prep numbers may differ from legacy). | ✅ |
| D-21 | Print card "Variable buffer" label shows effective rate; yield column still `y*100`. | ✅ |
| D-22 | Legacy `users[]` not migrated. `INITIAL_GM_EMAILS` (server-only env) matches **verified** primary emails only; the first match is written to Clerk `publicMetadata.role=gm`. Unknown/missing role → 403 "pending", never viewer. | ✅ |
| D-23 | `export` permission enforced server-side. | 🟡 |
| D-24 | Recipe photos stay base64 in DB; logos become static files / `Brand.logoUrl`. Object storage deferred to V1.1. | 🟡 |
| D-25 | **No deadline.** The 3-day limit is removed (supersedes SOURCE_OF_TRUTH §26 and MEGA_PROMPT §35). Nothing is deferred; every phase must pass its gates (tests, visual diff, security review) before the next. Full test suite, all screens, XLSX included. | ✅ |
| D-26 | Add append-only `IngredientPriceHistory` (old/new/source/user) and `Recipe.costAtLock` snapshot (cost, settings, price date) shown next to "cost now" on locked cards. | ✅ |
| D-27 | `Recipe.brandId` is **required**; a card cannot be created without a brand (supersedes the old "no brand" legacy case; none exist in data). | ✅ |
| D-28 | Requisition valuation fix + flags + reconciliation report (see D-10). | ✅ |
| D-29 | Lock gate: a card with a null-price line or missing conversion cannot be locked; a GM can override with a reason, audited and stored in `costAtLock.overrideReason`. | ✅ |
| D-30 | Dashboard "Average Food Cost": same unweighted mean as legacy, brand-scoped, plus a visible "N cards excluded (no selling price)" note. | ✅ |
| D-31 | Users tab: email invitation (Clerk `createInvitation` with `publicMetadata.role`); GM assigns brands; ban/unban via Clerk; protections: not the last active GM, not yourself. Order: check → Clerk call → DB update → audit, with compensation on DB failure. Audit "Clear activity log": append-only enforced in DB; implemented as an audited archive marker unless GM requires true purge. | ✅ / 🟡 |
| D-32 | Production quantities and menu headcounts require `recipe.edit` (legacy guard). | ✅ |
| D-33 | Renaming a recipe code updates all referencing RecipeLines and MenuCells in one transaction, rejects collisions (incl. across Ingredient namespace), audited with reference count. Code uniqueness is checked among non-deleted recipes; undo re-checks. | ✅ |
| D-34 | Concurrency: `version` on Recipe, Ingredient, CostSettings, Menu; PATCH sends expected version; mismatch → 409. Cycle check runs inside the save transaction under an advisory lock. Menu cells/production/pax are last-write-wins. | ✅ |
| D-35 | Auth: custom Clerk session claim carries role for UI gating/read speed; every request loads the `User` row and rejects inactive; Users-tab writes re-read Clerk. Brand scoping implemented once in the data-access layer (`visibleBrandIds(user)` required by every repository function); out-of-scope ids return 404. | ✅ |
| D-36 | Validation: all numbers finite (reject NaN/Inf); null price never becomes 0; line `y` in (0,10] else normalized to 1 as legacy; legacy unknown line codes tolerated on unchanged lines, rejected on new/changed ones; CSV cells starting with `= + - @` are neutralised (new safe behavior). | ✅ |
| D-37 | Imports: parse XLSX/CSV in the browser (worker, size/row caps), dry-run → commit in chunks of ≤500 rows with a server-side hash; photos downscaled client-side (~300 KB, 1 MB hard cap). | ✅ |
| D-38 | Print uses the browser (`window.print`, blob documents) like legacy; print CSS is one `print.css` imported globally and as a raw string for blob documents. `page.pdf()` is a local test technique only. | ✅ |
| D-39 | UI: legacy CSS verbatim in `legacy.css`; system font stack (no `next/font`); build real shell + Toast/Modal contexts + `<Perm>` wrapper first (no throwaway UI); list screens = server-loaded page + client component; no responsive additions (legacy has none). New Users/Menu screens use only legacy primitives. | ✅ |
| D-40 | Dashboard/costing data: three queries (items, conversions, recipes+lines, never photos), cached with `revalidateTag('catalog')`, brand filter applied after cache; no stored cost column. | ✅ |
| D-41 | Warn (not block) when a line has `y≠1` and `yp` set (double waste); label selling price "ex-VAT" and rename "Price at target" to "Price at target food cost" — wording changes to be confirmed with the user before UI port. | 🟡 |
| D-42 | Costing API returns the legacy result plus `complete:boolean` and `issues[]` (null price, missing conversion, unknown code, circular, no batch output, depth truncation). UI never shows a "clean" food-cost % as final when `complete=false` (shows an "incomplete" badge). Legacy numeric result is unchanged. | ✅ approved by user 2026-10-09. Implemented in `src/domain/costing/issues.ts` (`costWithIssues`); issue kinds: no-price, missing-conversion, unknown-code, not-a-sub-recipe, circular, no-batch-output. Depth truncation applies only to requisition expansion (flagged there). |
| D-43 | Price-list import: dry-run shows a per-item diff; changes above a variance threshold (default ±20%) are flagged "PRICE CHECK" for review. No maker/checker approval flow in V1. | 🟡 proposed |
| D-44 | Cost exports (CSV/XLSX) write an audit entry `Exported data` (kind, row count) — new, small. | 🟡 proposed |
| D-45 | Warning (not block) in the editor when a line has `y≠1` and `yp` set (double waste) — see D-41. | 🟡 proposed |

| D-46 | Requisition expansion skips blank-code rows (legacy bucketed them under `?` as "(not in library)"), consistent with costing which already skips them. Golden has 0 blank rows, so no numbers change. Found in the Phase 2 code review. | 🟡 default (implemented; tell me if you want the legacy behaviour) |
| D-47 | Amends D-10: in requisition expansion a line that points at a sub-recipe is read as a quantity of that sub-recipe's batch unit (as costing reads it), so the sub is expanded for qty × output ÷ batchSize portions (batchSize = batchOut, else subQty; if both are 0 the legacy value is kept). Legacy passed the line qty as portions (≈22.7× over-draw on GRM-MN-0001). The `sub-scale` flag is now informational. | ✅ approved by user 2026-10-09 |
