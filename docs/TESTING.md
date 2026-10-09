# TESTING — strategy, required cases, baselines
Tools: Vitest (unit/integration; real Postgres via Docker or a Neon branch, one schema per worker, TRUNCATE between tests; mock `@clerk/nextjs/server` `auth()`/`clerkClient` in one `vi.mock`; call handlers with `new Request()`), fast-check (property), Playwright + pixelmatch (visual, pinned Chromium/OS). CI: typecheck, lint, test, build; DB tests apply `db/migrations` to a short-lived Neon branch via `npm run db:migrate`.

## 1. Costing oracle (Phase 2 gate)
- **Golden diff:** all 321 cards: every field of `cost()` vs `golden/costs.json` — exact (`toBe`) on doubles; rows keyed `code|id`.
- **Synthetic priced cases** (golden has only 1 priced card): set `sp=100` on every card; with default settings assert `totalCost = food + 0.5*sp`, `net = sp - totalCost`, `vatPrice = 1.15*sp`, `suggest = food/0.3`; worked example food=30 → fc 30%, pkg 10, del 10, lab 25, ops 5, total 80, net 20, np 20%, suggest 100, vat 115. Repeat with `output>1`. Vat-only change moves only `vatPrice`.
- **Yield matrix:** `y` ∈ {0, 0.5, 1, 10, 11, -1, NaN} (≤0 or >10 → treated as 1); `yp` ∈ {0, null, 15}; yp=0 stays 0, null falls back to card buffer then settings.buffer. Sum invariant Σ line cost·(1+p)/out = food.
- **Edge cases:** null-price item (cost 0, err 'no price'), unknown code, menu-type code as line (err 'not a sub-recipe'), blank code lines skipped, needConv (wrong unit, wrong direction factor, missing conversion) → cost 0 + 'missing unit conversion' precedence, conversion applied by division, nested sub buffer applied once (1.15 not 1.1025), sub with no batchOut ('no batch output'), cycle (`circular`) incl. A→B→A and self, sub-of-sub, empty lines.
- **Property tests:** cycles never hang; cost ≥ 0 for non-negative inputs; scaling all qty by k scales batch by k; reprice +10% of one ingredient moves each dependent card by exactly qty·price·(1+yp)/(y·out)·0.1 and leaves unrelated cards unchanged.
- **Requisition/production:** per-line expansion matches legacy `reqExpand` (depth ≤4, y unclamped `||1`, any-type case-insensitive sub match, `?code` bucket); conversion-aware valuation; flags for unconvertible lines and depth truncation; reconciliation: for cards with no conversions and no yp, requisition value of one batch equals batch cost within 1e-9; variance for yp cards equals the buffer exactly; report differing cards.
- **Planning:** `planFindCard` (alias + fuzzy rules) against all 1001 menu cells matches legacy results; `planCost` floors.
- Price precision: 0.00008 and 10-decimal prices round-trip import → DB → API → export bit-identical; CSV exports keep ≥6dp. Σ non-null item prices equals legacy sum to 1e-9.
- Coverage gate on `src/domain` ≥ 95%.

## 1b. Database tests (exist today)
`tests/db/*.test.ts` run against a real Neon branch when `TEST_DATABASE_URL` is set (skipped otherwise): schema constraints/triggers/cascades/double round-trip and the pg layer (pool, `withTransaction` commit/rollback, `visibleBrandIds`, race-safe provisioning). CI runs them on a throwaway schema-only branch; see docs/RUNBOOK.md §4a. New repository code adds its tests here; unit tests that only need SQL results use the `Queryable` fake (see `tests/scope-env.test.ts`).

## 2. Seed/verification suite (Phase 3 gate) — see schema.md "Post-seed verification"
Counts (1046/321/7321/34/14/8/146/1001, 135 null prices, 161 flags), code sets equal both ways, no case collisions (within and across Ingredient/Recipe), 0 unresolved line codes, no MENU recipe used as a line, no self references, menu cells resolve, PLAN_ALIAS targets exist, no whitespace in codes, float round-trip (BKR2-2058 = 0.006667, DRS1-4772 = 0.0064), all 321 costs recomputed from DB == golden, AuditLog UPDATE/DELETE/TRUNCATE raise, partial unique index allows soft-delete + reuse, seed twice → no change, prod load aborts if audit rows exist.

## 3. Authorization suite (Phase 4 gate)
- Table-driven matrix: 6 roles × every endpoint → expected 200/403 (derived from ROLES + `menu.edit`; GM-only `users.manage`, `data.admin`, `brands.edit`).
- Missing/invalid role → 403 pending; inactive user → 403; INITIAL_GM_EMAILS only for verified email.
- Brand IDOR: non-GM PATCH/GET other-brand recipe → 404; PATCH brandId requires both brands; lines referencing out-of-scope scoped ingredients/sub-recipes rejected; lists filtered; dashboard/production/requisition/menus scoped; user with zero brands sees nothing; Shared ingredients visible to all.
- Locked recipes: every edit path (fields, lines, method, photo, yield, price, code rename) → rejected; TOCTOU (lock racing an edit) test; delete of locked needs `recipe.unlock`; import skips locked; bulk ops all-or-nothing.
- Finance PATCH limited to price fields; Chef/Cook cannot price/delete; Viewer read/export only.
- Concurrency: two parallel PATCHes → one 409; cycle race (A→B and B→A simultaneously) → only one succeeds; last-GM race (two GMs demoting each other) → one refused.
- Audit: actor from session not body; role from fresh Clerk read; same transaction (rollback leaves no audit); cleared-log path appends marker only.
- "Every route file exports a `withAuth`-wrapped handler" meta-test. Zod: NaN/Infinity/negative/oversized payloads → 400. CSV injection neutralisation. Import: dry-run validates, invalid row → whole commit refused, duplicate codes, combined graph cycle, brand change rules, zip-bomb/row-cap rejection, XLSX fuzz.
- Users tab: invitation, role change, ban (immediate effect via `User.active`), delete, compensation on DB failure (mocked), self/last-GM protections.

## 3b. Images suite (Phase 3/4 gate; D-48/D-49)
- `sniffImage`: PNG/JPEG/WebP detected by magic bytes with correct width/height; SVG, GIF, HTML-as-PNG, truncated/corrupt headers, 0-byte, oversize, over-dimension → rejected; declared content-type/extension ignored.
- Routes: PUT/GET/DELETE photo and logo; permission matrix (photo `recipe.edit`, logo `brands.edit`); LOCKED card → 422; out-of-scope brand → 404; list/dashboard endpoints never include bytes; `ETag`/304; `nosniff`; round trip bytes + sha256 equal; seeded logos' sha256 equal `public/assets/*`; replace changes the `sha8` in the DTO url; audit entries written in the same transaction.
- Add-brand-with-logo two-step including failure of step 2 (brand kept, UI message).
- Print: card print HTML contains the photo/logo inlined as a data URL.

## 4. Finance reconciliation (before go-live)
Dashboard totals per brand vs `golden/costs.json`; a hand-checked priced sample (GRM-MN-0001: sp 108, food 29.63, fc 27.4%, net 24.37, suggest 98.76); settings change audit shows cards affected; locked card shows cost-at-lock vs cost-now; price history entries on every price change/import/menu-plan price; requisition reconciliation report reviewed; counts of flagged data-quality items surfaced on Health (135 PRICE MISSING, 4 PRICE CHECK, 8 UNIT CHECK, 7 "second sheet price", 3 SMC copy, others).

## 5. Visual baselines (Phase 5; procedure)
Baselines must include: recipe editor with and without photo, Add-brand row with the logo box, Edit brand modal with and without logo.
1. Serve `legacy/app.html` over a static server (not `file://`) with Playwright using one pinned Chromium on one OS/Docker image for both baselines; viewport 1440×900 (768×1024 informational only — legacy has no breakpoints, so no mobile parity); `deviceScaleFactor 1`, `reducedMotion`, CSS to disable transitions/animations/caret.
2. `addInitScript` sets localStorage `isfc_costing_v1` = `golden/state.json` and signs in a GM (or drive the PIN login once and save `storageState`). Freeze the clock (`page.clock`/overridden `Date`) because `priceDate`, "Printed", `when()` and `uid()` use `Date.now`; mask `#savedot`/`#verline` volatility.
3. Navigate by calling `go('route', id)`; screenshot full pages for every route plus states: modal open, toast visible, `.selbar` with selection, Items and Recipes pages 1 and 2, recipe edit, locked recipe, a brand with Arabic name tile.
4. Print: `page.emulateMedia({media:'print'})` + `page.pdf({format:'A4', preferCSSPageSize:true})`, rasterize (`pdftoppm`), pixelmatch ~0.1% threshold — recipe cards for several brands (long method, multi-page ingredient lists), prep/production/store sheets, print-the-screen mode. Also a unit test that blob print documents contain the `.pc`/print rules (page.pdf does not catch that regression).
5. Run the new app on a seeded test DB with identical data. Mask only elements that are new (Users, Menu editor, Clerk components). Store baselines in the repo with Playwright version and OS pinned.

## 6. Definition of done per phase
typecheck + lint + all tests green; oracle diff 0; seed verification green; authz suite green; visual diffs under threshold; `/code-review` and `/security-review` clean; docs (this folder, DECISIONS.md, PROGRESS.md) updated in the same change.

## 7. Tests required by the resolved decisions (add with the feature)
- D-43: price import dry-run flags exactly the items with |Δ%| > 20 (boundary 20.0 → not flagged; null → price = "new", never a variance), flag appended once and existing flags preserved verbatim.
- D-44: every export endpoint writes one `Exported data` audit row with kind and row count; a failed export writes none.
- D-45: editor shows the note only when `y≠1` and `yp` is set; `cost()` output identical with or without it.
- D-31: `Cleared activity log` marker is written; audit list hides older entries by default and returns them with `archived=1`; no row is ever deleted (DB trigger still blocks DELETE).
- D-52: brand site rename updates `menu_pax.location` and `production_entry.location` atomically (rollback on failure); removing a site with rows → 409 with count; duplicate/empty/`|` names rejected; only `brands.edit`; audit row lists rows updated.
- D-41: a snapshot test asserts the Backup subtitle text and that no other legacy label changed.
