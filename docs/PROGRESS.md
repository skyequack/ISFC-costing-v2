# PROGRESS — living checklist (update in the same commit as the work)

Last updated: 2026-10-09 (branch `phases-build`). **Phases 0–6 are implemented and green except the items listed under "Not verified / needs you" below. Phase 7 (deploy) was deliberately not started.**

## Phase 0 — Discovery ✅

- [x] Legacy fully mapped → `docs/legacy/*`, `DISCOVERY_FINDINGS.md`; oracles `golden/*`, `db/seed-data/*`, `tools/*`
- [x] Decision round and review applied (D-01…D-53); this phase added D-54…D-57

## Phase 1 — Foundation + real shell ✅ (except the Vercel deploy → Phase 7)

- [x] Next.js 15, strict TS, ESLint (domain purity rule), Prettier, Vitest, CI (`check` + `db` jobs)
- [x] Clerk middleware (deny by default), `getSession`, `withAuth`/`withPublic`, lazy `app_user` upsert, `INITIAL_GM_EMAILS` bootstrap (verified earlier against real Clerk)
- [x] Shell: legacy CSS verbatim, sidebar with the active-brand chip (cookie workspace), header with runtime title/subtitle (`<PageTitle>`), `#acts` slot, print layer (`#prthead`, `#pvbar`, `#printcard`), Toast + Modal contexts, `<Perm>`
- [ ] Empty Vercel deploy; Clerk session-token role claim `{"role":"{{user.public_metadata.role}}"}` (Phase 7 / RUNBOOK §3)

## Phase 2 — Costing & production domain ✅

- [x] Costing engine line-for-line, golden diff 321/321 exact, synthetic + property tests, `costWithIssues` (D-42)
- [x] Requisition (D-10/D-28/D-47), reconcile, graph (cycles)
- [x] **Planning domain** `src/domain/menu-plans` (plan matcher proven **identical to the legacy `planFindCard` for every dish text** by evaluating the legacy function from the frozen file; `planCost/planDay/planWeek/menuPreview/menuDemand/prepDemand`) and `src/domain/production/day.ts` (D-20 all-sites sums), `src/domain/ingredients/variance.ts` (D-43)
- [x] Coverage gate on `src/domain`: 100% lines/functions, 96.5% branches (≥ 95)

## Phase 3 — Data layer, seed, vertical slice ✅

- [x] Seed + post-seed verification (30 DB tests); read repositories, catalog loader/cache, `ImageStore`
- [x] **Write services** (`src/lib/services/*`, all run in the caller's transaction): recipes (create / save with field-level permissions, optimistic version, advisory-locked cycle check, code uniqueness across cards and ingredients, rename cascade D-33, auto-code re-allocation, duplicate, soft delete + restore, lock gate D-29 with GM override and `cost_at_lock` snapshot D-26, unlock, bulk), ingredients (+ price history, conversions), brands (+ sites D-52), settings, planning (menus editor, headcounts, production, apply-menu-day, menu price), audit (D-31 archive marker), users (Clerk port, D-31), imports, exports, backup/restore
- [x] **Routes** for everything in docs/API.md (all through `withAuth`; meta-test enforces it)
- [x] Images: PUT/GET/DELETE photo and logo, magic-byte validation, ETag/304, scope/permission/lock rules (route tests)

## Phase 4 — Authorization & integrity ✅

- [x] Table-driven matrix: 6 roles × every permission-gated endpoint (`tests/authz-matrix.test.ts`, 243 cases); allow-list of service-gated endpoints so a new open route cannot slip in
- [x] Service tests against Neon (rolled back): field-level recipe PATCH, locked cards on every edit path, brand IDOR 404 on read/save/delete/duplicate/photo, scope of ingredient lines and items, cycle and code-collision rules, lock gate, bulk all-or-nothing, concurrency (409), users tab rules with a fake Clerk (self / last-GM / compensation), audit marker, export audit (D-44)
- [ ] Not automated: two truly parallel PATCH/lock races (the advisory lock + `FOR UPDATE` + version check are exercised sequentially; a parallel-connection test needs a second pool)

## Phase 5 — Full UI port ✅ (visual baselines NOT automated — see below)

- [x] Screens (legacy markup/classes, inline styles via `s()`): Brand Workspaces, Dashboard, Recipe Cards (list, bulk, filters), Recipe editor (autosave per field, server-costed, autocomplete, "Search raw materials", Σ Calculate cost, photo, lock/unlock/duplicate/delete+undo), Locked card view + history + cost-at-lock, Print (card, production sheets, store requisition), Ingredient Library, Unit Conversions (live preview), Yield Reference, Cost Settings (+ brands, sites D-52, add-brand with logo D-48), Data Health, Activity Log, Users & Access (new), Backup & Export, Menu Plans (+ basic editor D-05), Preparation, Production (Daily / Store requisition / Monthly, menu builder)
- [x] D-45 double-waste note; D-30 "N cards excluded" note; D-31 "Show archived"; D-41 Backup subtitle (label snapshot test: every other NAV/TITLES string equals the legacy one)
- [x] UI interaction tests (jsdom, `tests/ui`): editor autosave/versioning/conflict, lock dialog + GM override, autocomplete pick, list paging/filters/bulk delete + undo, item modal (null price), conversion preview, settings percent → fraction, add-brand logo box, role gating
- [x] `npm run preview:screens` renders every screen from the dev data into `public/_preview/*.html` (gitignored) for a visual look without signing in

## Phase 6 — Import / export / XLSX / print ✅

- [x] `src/lib/xlsx` (stored-zip writer, bounded reader, regex XML scan — no DOM), RFC-4180 CSV reader/writer with formula neutralisation (D-36)
- [x] Price-list import (D-43 ±20% PRICE CHECK, history `IMPORT`, hash-checked dry-run → commit in ≤ 500-row parts) and recipe import (flat template **and** the kitchen block layout, kg/litre scaling, brand column, locked skipped, cycle/duplicate/collision checks, D-17 `Waste %` / `Card Buffer`)
- [x] Exports (all server-side, `export` permission, brand scope, audit D-44): costing summary, recipe lines, ingredients, requisition, production (D-19), preparation, menu plan, re-uploadable recipe sheet (Excel/CSV), price-list templates; round-trip test: export every card → xlsx → parse → dry-run = all updates, nothing blocked
- [x] Backup/restore: JSON v1 in parts (core + base64 images), chunked staging upload (migration `0002_restore_staging.sql`), dry-run = apply-and-rollback, commit on the direct connection in one transaction (D-54, D-56)

## Gate status (2026-10-09)

typecheck ✅ · lint ✅ · prettier ✅ · `npm test` 484 passed (83 DB tests skipped offline) ✅ · domain coverage 100% lines/functions, 96.5% branches ✅ · `next build` ✅ (dummy env) · DB suite against Neon `dev` ✅ (see `docs/TESTING.md` for the command; ~12 min because every statement is a network round trip)

## Not verified / needs you

- **Not signed in to Clerk in the browser pane** (and the assistant must not sign in with your credentials), so no authenticated click-through, no pixel diff against the legacy file, and no Playwright visual baselines were produced (docs/TESTING.md §5 stays open). What exists instead: server-side render of every screen with the real legacy CSS (`npm run preview:screens`, looked at in the browser pane), the label snapshot, and the jsdom interaction tests.
- Please do a manual pass in the real app as the GM: create/edit/lock a card, upload a price list and a recipe sheet, run a backup + restore on a **throw-away Neon branch**, open Production/Preparation/Menu Plans for the SSEM workspace, invite a user.
- Parsing of big spreadsheets runs on the main thread (the plan said "worker"): caps are 25 MB file, 20 000 rows, 80 columns, zip-bomb guard. A worker is a later improvement.
- Clerk session-token role claim, Vercel project (region `fra1`), GitHub CI variable/secret: Phase 7 / RUNBOOK.

## Live GM pass (2026-10-10, signed in by the user, Neon `dev`)

Create/rename/add-ingredient/cost/lock/unlock/delete a card, Production entry in SSEM, and a 200 from all 12 other screens: all worked, numbers matched (Beef Steak food cost 29.628; line cost = qty × price × 1.15). Not yet done live: file uploads, backup/restore, Preparation, Menu Plans, inviting a user.

- Fixed: ingredient pick showed "unknown code" until the save returned (the row now shows the picker's name/UoM/price at once); two line edits in the same tick overwrote each other (edits now start from the newest lines, `linesRef` in `EditScreen`); both have jsdom regression tests. Brand-logo tiles load lazily.
- **Speed** (measured with `SQL_TRACE=1|2`, `src/lib/db/trace.ts`; launch config `isfc-dev-trace`): one Neon round trip ≈ 84 ms from the dev machine (eu-central-1), cold connect ≈ 1.9 s. A name-only PATCH runs 17 statements (≈ 2.2 s of 2.5 s), a lines PATCH 23, a card GET 10, create 13, delete 7. Reducible: card + lines + method loaded in 3 statements (1 would do); the advisory lock is taken even when no line/code/type changes; brand-scope and user lookups repeat on every request; the full catalog (ingredients + all recipes) is reloaded inside every save to recompute the cost view. Not yet changed (decision pending). Deployed in fra1 next to Neon the same statements cost far less; re-measure after Phase 7.
- **Speed work, step 1 (docs/PERF_PLAN.md R1, R2, R3, R5), 2026-10-10.** R1: `saveRecipe` loads card + lines + method in one statement (`lockHeadWithBody`). R2: the graph/code advisory lock is taken only when lines, code, type or brand change. R3: audit rows (and the 10-minute "Edited card" collapse) go in one `appendAuditMany` statement. R5: when the session token carries the `role` claim, `getSession` reads the user row and the visible brand ids in one query and attaches the scope to the user object (`attachScope` in `db/scope.ts`; the scope is read at request start instead of inside the transaction, same READ COMMITTED visibility). Measured with the tracer: name-only PATCH 17 → 14 statements, lines PATCH 23 → 21. **R5 has no effect yet and is not verified end to end:** this Clerk instance's session token has no `role` claim (RUNBOOK §3 step, a dashboard setting), so every request still calls the Clerk API for the role; setting the claim is the cheapest remaining speed-up. Tests: `tests/db/save-path.test.ts` (5), `tests/scope-prefetch.test.ts` (4); existing services/routes/planning DB tests pass (31). **R4 done (2026-10-10):** `recipeDetail` no longer loads the whole catalog. `getRecipe` is one statement (head + lines + method + history), and `loadCostClosure` (`db/catalog.ts`) fetches in one statement only the items, conversions and sub-recipes reachable from the card's line codes (recursive CTE, UNION so cycles end, the card itself always included, lines in `sort_order`), plus settings and packaging; the unchanged `buildContext`/`buildCardView` then cost it. Statements now: name-only PATCH 17 → 9, lines PATCH 23 → 15, GET card 10 → 4 (live trace; costs unchanged, Beef Steak 29.62836). Equivalence proof: `tests/db/cost-closure.test.ts` costs all 321 live seed cards from the closure and from the full catalog and requires identical views (view, issues, per-line costs), plus cycle, self reference, missing price, missing conversion, unknown code, blank row, soft-deleted sub-recipe, packaging, and `getRecipe` history dates. Not done: lock/import/planning still load the full catalog on purpose (lock gate needs one snapshot of all prices). **Editor save batching done (2026-10-10):** `EditScreen.save` sends the first edit at once; edits made while a PATCH is in flight (or in the same tick) merge into ONE follow-up request (last value per field wins, `lines`/`method` are full arrays, newest `version` read at send time). A `sellingPrice` edit is never merged with other fields (it needs `recipe.price`, the rest `recipe.edit`). Live: 5 edits in under a second = 2 requests (was 5), saved values correct. Tests in `tests/ui/screens.test.tsx` (same-tick, in-flight merge + price kept separate). A failed merged save toasts once and refreshes on 409/422 like before; its edits are not retried. **R6 + R8 done (2026-10-10):** `saveRecipe` is now two statements for a scalar edit: one load (`loadForSave`: card + lines + method + history + the cost closure + settings, under the row lock) and one that does the version-checked UPDATE and writes the audit rows together (`WITH u AS (UPDATE ... RETURNING version, updated_at), a AS (INSERT INTO audit_log ...)`; zero rows updated = 409, which discards the audit rows with the transaction). `saveRecipeWithDetail` (used by `PATCH /api/recipes/[id]`) builds the editor payload from the loaded rows plus the returned version/updated_at with the new scalars overlaid on the card itself (`parseClosure(..., override)`), so there is no re-read; edits to lines or the code still re-read via `recipeDetail`. Method steps keep their own DELETE/INSERT (the unique `(recipe_id, sort_order)` constraint is not deferrable, so lines are deliberately not folded into a CTE). Live statements for a name-only PATCH: 17 → 6 (user, BEGIN, scope, load, update+audit, COMMIT); lines PATCH 23 → 14. Live timing (dev, Neon eu-central-1 from this machine): name-only 2.5–3.4 s → 0.86–0.9 s, price+output 0.88 s, lines 3.1–5.1 s → 1.7 s, GET 2.0 s → 0.70 s. Tests: `tests/db/save-path.test.ts` (8; no-re-read payload `toEqual` a fresh read for ten scalar edits incl. a self-referencing card, fallbacks, guards 409/403/404/422), services/routes/closure DB suites pass. Not done: R7 (user cache, needs a DECISIONS row) and R9; the role claim in Clerk (RUNBOOK §3) would remove 2 more statements per request (user+scope in one) and a Clerk API call.
- Tool: `node --env-file=.env.local tools/rtt.mjs` prints the database round-trip time.

## Loading states (2026-10-10, D-59)

Every route has a skeleton (`src/app/*/loading.tsx` → `src/components/shell/Skeletons.tsx`: dash, list, editor, cards, form, sheet kinds, built from the legacy blocks, no text) and a 3 px progress bar (`src/components/shell/nav-progress.tsx`, styles in `src/styles/loading.css`, legacy.css untouched). The bar starts 120 ms after a navigation or `router.refresh()` begins (instant navigations never flash it), runs while the transition is pending or a skeleton is still on screen, and finishes when the real page replaces the skeleton, so pages need no code. Screens import `useRouter` from `nav-progress` (wrapper over next/navigation's). No client data cache or preloading (user decision). Live (dev): skeleton ≈ 130 ms after a click on a warm route, bar from ≈ 250 ms, real page 0.8–1.8 s. First hard load of a page still waits for the root layout (session + brand counts) before anything streams; a skeleton there would need a Suspense split of the layout. Tests: `tests/ui/nav-progress.test.tsx` (5), `tests/loading-routes.test.ts` (every page route has a loading.tsx).

## Open items for the user (decisions that were NOT made for you)

- ~~Stale PIN / "stored in this file" wording~~ — resolved by D-58 (approved 2026-10-10).
- **D-54 / D-56 defaults** (Backup screen trimmed; restore semantics; strict recipe import) are marked 🟡 in DECISIONS.md — approve or change.
- Recipe list order is by code (legacy used array order: demo cards, SSEM, SMC, NC).
- Existing ingredients that a restore/backup does not contain are **kept** (history cascades otherwise); only cards are soft-deleted.

## Decisions log pointers

All decisions: `DECISIONS.md`. Any divergence from legacy needs a row there **before** coding.

## Known gaps from the Phase 3–6 `/code-review` (high)
- **No rate limiting (429)** on import/export/photo/user/restore routes (ARCHITECTURE §2 asks for ~10/min/user). Needs Upstash or Vercel Firewall — Phase 7 / your call.
- Small duplications left on purpose: `needAdmin` guards per service, header-alias mapping in `src/lib/import/{items,recipes}.ts`.
- Editor: a `router.refresh()` that lands while a save is still queued can briefly show the server copy before the save returns.
- `/security-review` could not be run (the skill needs an `origin` remote; the repo is local-only). Run it once the repo is on GitHub.
