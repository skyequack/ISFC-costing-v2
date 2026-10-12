# PROGRESS — living checklist (update in the same commit as the work)

Last updated: 2026-10-12. **Phases 0–6 are done. Phase 7 (deploy, D-62) is partly done**: Vercel and Neon `production` are live; the remaining steps wait on Omer (see "Open items"). **Phase 8 (new features, D-64):** see the feature log in `docs/FEATURES.md` and the summary below. The detailed narrative of every phase and slice up to 2026-10-12 was condensed on that day; the full text is in git history (`git show d9f05e3:docs/PROGRESS.md`).

## Current state
- **Git:** only `main` exists, locally and on GitHub (`skyequack/ISFC-costing-v2`). Merged feature branches were deleted 2026-10-12.
- **Deploy:** https://isfc-costing-v2.vercel.app (functions in `fra1`). Production served `98955e8` on 2026-10-12 (confirmed by Omer).
- **Databases:** Neon `dev` and `production` are both on migrations 0001–0008; checksums equal the files in `db/migrations/`. 0008 went to `production` on 2026-10-12, after the snapshot `production-before-0008-2026-10-12` (`snap-ancient-cake-b24ar119`); data counts were identical before and after (1046 ingredients, 321 live cards, 7327 lines, 14 brands, 2 users, 43 audit rows). Kept: `production`, `dev` and that snapshot. CI creates and expires its own `ci-*` branches.
- **This dev machine:** Node needs `NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection"` for Neon (IPv6 times out). `.claude/launch.json` has `isfc-dev-3100` (port 3000 can be taken) and `isfc-dev-trace` (`SQL_TRACE=2`).

## Gate status
- **2026-10-12, after the debloat (below):** typecheck ✅ · lint ✅ · prettier ✅ · `npm test` 717 passed / 155 skipped ✅ (same as after rate-limiting slice 3; the DB suites need `TEST_DATABASE_URL`) · not run: `next build`, coverage, the DB suite.
- On Windows use `npx prettier --check --end-of-line auto .` (the working tree is CRLF and the repo stores LF through `core.autocrlf`, so a plain check flags every file).
- **Last full DB suite:** Neon `dev`, 2026-10-12, after `48ca819`: 153 passed, 2 failed, both in `seed.test.ts`, which checks against pristine seed data (`dev` has been edited by hand: 129 unpriced ingredients against the seed's 135, MNU-0002 repriced). The same file passes in CI, which seeds a fresh branch. About 12 min, because every statement is a network round trip (command in `docs/TESTING.md`).

## Open items
**Waiting on Omer**
- [ ] Clerk session-token claim `{"role":"{{user.public_metadata.role}}"}` (RUNBOOK §3). This is also the cheapest remaining speed-up: without it every request calls Clerk for the role (docs/PERF_PLAN.md).
- [ ] GitHub repo variable `NEON_PROJECT_ID` and secret `NEON_API_KEY` for the CI `db` job (RUNBOOK §4a).
- [ ] Clerk **production** instance keys and domain at final handoff (decision 2026-10-10: stay on dev keys until then, so sign-in shows "Development mode").
- [ ] Manual checks the assistant cannot do: a backup **restore commit** on a throwaway Neon branch (only dry-runs so far), a user invitation (emails a real address), a second-device persistence check, real printing (`window.print` is blocked in the pane), non-GM roles in a real browser (covered by the 243-case authz matrix only).
- [ ] Re-measure latency in production, then decide PERF_PLAN R7/R9.
- [ ] `/security-review` of the whole app has not been run yet (it is no longer blocked: `origin` exists).
- [ ] Vercel Firewall rate rules and Bot Protection for the unauthenticated surface: set up by Omer in the dashboard (reported 2026-10-12), not verified from here.

**Known gaps (engineering)**
- No visual baselines against the legacy file (docs/TESTING.md §5): Clerk is the only auth and the assistant does not sign in with Omer's credentials. Instead there are `npm run preview:screens`, the label snapshot test and the jsdom interaction tests.
- Not automated: truly parallel PATCH/lock races, the client delete-vs-write race, and a concurrent double stock commit (all need two committed connections; the row locks, advisory locks and version checks are exercised sequentially).
- Large spreadsheets are parsed on the main thread (caps: 25 MB, 20 000 rows, 80 columns, zip-bomb guard); a worker is a later improvement.
- Editor: a `router.refresh()` that lands while a save is queued can briefly show the server copy.
- A stock upload can be undone only from its result dialog; there is no list of past uploads.
- Rate limiting: a restore larger than about 180 MB of JSON (150 chunks) cannot finish inside one 10-minute window (a backup with a photo on every card is about 130 MB). Not exercised live: the automatic retry and fetch-based downloads (jsdom only), and counter writes on `production`.
- Dashboard redesign: phone layout and keyboard use not checked; architect data review requested.
- D-61 left open: type-to-confirm, "Today", sticky menu-plan columns, sidebar compaction.
- Small duplications kept on purpose: `needAdmin` guards per service, header-alias maps in `src/lib/import/{items,recipes}.ts`.
- Behaviour to remember: the recipe list is ordered by code (legacy used array order); ingredients missing from a restored backup are **kept** (history cascades otherwise), only cards are soft-deleted.

## Phase summary
- **Phase 0 — Discovery ✅:** legacy mapped (`docs/legacy/*`, `DISCOVERY_FINDINGS.md`), oracles `golden/*`, `db/seed-data/*`, generators in `tools/`; decisions D-01…D-57.
- **Phase 1 — Foundation ✅:** Next.js 15, strict TS, ESLint with the domain purity rule, Prettier, Vitest, CI (`check` + `db` jobs); Clerk middleware deny-by-default, `withAuth`, lazy `app_user` upsert, `INITIAL_GM_EMAILS`; shell with the legacy CSS, print layer, Toast and Modal contexts, `<Perm>`.
- **Phase 2 — Costing and production domain ✅:** engine ported line for line, golden diff 321/321 exact; requisition, reconcile, graph; planning domain (matcher identical to the legacy `planFindCard` for every dish text); `src/domain` coverage 100% lines/functions, 96.5% branches.
- **Phase 3 — Data layer ✅:** seed + post-seed verification, repositories, catalog cache, `ImageStore`, all write services (run in the caller's transaction), every route in `docs/API.md` behind `withAuth` (meta-test), images with magic-byte checks and ETags.
- **Phase 4 — Authorization ✅:** 243-case role × endpoint matrix; service tests on Neon for field-level permissions, locked cards, brand IDOR 404s, cycles, code collisions, lock gate, bulk all-or-nothing, 409 concurrency, users rules.
- **Phase 5 — UI port ✅:** every screen with the legacy markup and classes; D-30, D-31, D-41, D-45; jsdom interaction tests; `npm run preview:screens`.
- **Phase 6 — Import/export ✅:** own XLSX/CSV reader and writer (D-36), price-list import (D-43), recipe import (flat and block layouts), server-side exports with audit (D-44), chunked backup/restore (migration 0002, D-54, D-56).
- **Live passes 2026-10-10:** full GM click-through on `dev` and a signed-in smoke on production (cards, ingredients, imports, exports, print layer, restore dry-run of a full backup in 3.9 s). Bugs found were fixed with regression tests (ingredient pick showed "unknown code", two line edits in one tick, editor crash when a line was added during a save).
- **Speed work 2026-10-10:** docs/PERF_PLAN.md (name-only save 17 → 6 statements, about 0.9 s on `dev`).
- **Loading states (D-59), sidebar footer credit (D-60), wording fixes (D-58).**
- **Phase 7 — Deploy (partly):** Vercel project in `fra1` with env vars; `production` migrated and seeded once (2026-10-10: 1046 ingredients with 135 null prices, 321 recipes, 7321 lines, 14 brands); `DATABASE_URL*` env fix (they first pointed at `dev`); signed-out and signed-in smoke tests. Remaining steps are under "Open items".

## Phase 8 — New features (D-64)
Status and decision rows per feature are in the `docs/FEATURES.md` feature log; behaviour and strings in `DECISIONS.md`. Built and merged:
- Feature team (`.claude/agents/*`, `/feature-team`, `docs/FEATURES.md`).
- Dashboard slice 1 (D-65…D-67): filter bar, Menu Matrix, margin at risk, cost drivers, unpriced exposure, over target, `dash` export.
- Slice 2a clients + client in the production key (D-71, D-72; migration 0003) · 2b stock tables, API and Stock screen (D-72, D-73; 0004) · 2c stock upload (D-73; 0006 index) · 2d Theoretical vs Actual + Client filter (D-74, D-82) · 2e stock in backup/restore, site rename carries stock, Data Health checks (D-75, D-76, D-83).
- Users: pending invites, revoke, edit access, Select all brands (D-78…D-81; 0005). A role change revokes the old invitation, then creates the new one (Clerk returns the old invitation if you create first).
- Dashboard redesign: five tabs, KPI tiles, charts (D-84); Overview URL fix (`44d3d75`).
- Slice 3: three-stage line yield (D-70, D-85; 0007).
- Import templates card on Backup & Export (D-86).
- Rate limiting (D-87…D-90; 0008): per-user fixed-window counters in Neon on 22 heavy handlers in 8 classes (`src/lib/rate-limit/budgets.ts`), fail-closed for restore and user administration, browser handling of 429. Checked live on `dev` 2026-10-12 (the 41st invite in an hour got 429 with `Retry-After`).
- Factory-floor ergonomics (D-61, `2334bab`).
- [ ] Slice 4 (optional): menu-mix shift, price-change impact, locked-card drift — not started.

## Debloat (2026-10-12)
No behaviour change. Code: removed exports nothing used (`vars` in `components/ui.ts`, `noStore` in `lib/api.ts`, `appendAuditMany` in `db/repo/audit.ts`, `fin` in `lib/http.ts`, `SCREEN_ROUTES` in `lib/nav.ts`, `SettingsFacts` in `lib/screens/rows.ts`); the unit list, defined six times, now lives once in `src/lib/units.ts`. Dependencies: removed the unused `@neon/env`, `@playwright/test` and `pixelmatch`, plus `playwright.config.ts`, `e2e/` and the `test:e2e` script (docs/TESTING.md §5 says to reinstall them with a DECISIONS row when visual baselines are built). Files: deleted the root `ISFC_Costing_System_v8.7.html` (byte-identical to `legacy/app.html`), `plan.md` (superseded by this file) and `PR_DESCRIPTION.md` (the merged Phases 3–6 PR text). Docs: condensed `SOURCE_OF_TRUTH.md`, `MEGA_PROMPT.md`, `docs/PERF_PLAN.md` and this file; `FUNCTION_MAP.md` now points at the real files; stale paths fixed in `docs/UI_PORT.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`. Full texts stay in git history at `d9f05e3`.
