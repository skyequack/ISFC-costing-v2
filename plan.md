# plan.md — ISFC migration execution plan (current agreed architecture)

Precedence: **DECISIONS.md overrides SOURCE_OF_TRUTH.md / MEGA_PROMPT.md** where they differ (see amendment blocks at the top of each).
Entry point: `README.md` → `docs/PROGRESS.md`. Docs: `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/TESTING.md`, `docs/UI_PORT.md`, `docs/RUNBOOK.md`, `docs/legacy/*`, `DISCOVERY_FINDINGS.md` (what the source does) · `schema.md` · `DECISIONS.md` · `FUNCTION_MAP.md` · `CLAUDE.md`.
Oracle (read-only): `legacy/app.html`, `golden/state.json`, `golden/costs.json`. Generators: `tools/*.js`.

## Status
- [x] Phase 0 discovery, oracle, assets, seed JSON, docs.
- [x] Decision round (D-01…D-41) and 5-role review (architect, finance, UI, backend, DBMS) applied.
- [ ] Phase 1 onward (below). **No deadline (D-25): quality gates, not dates.**

## Stack
Next.js App Router + TS strict · Prisma 6 · Postgres (Neon; pooled `DATABASE_URL` at runtime, `DIRECT_URL` for migrate/seed/import) · Clerk · Vercel · Zod · Vitest (+fast-check) · Playwright + pixelmatch. Env (user supplies in `.env`, server-only unless NEXT_PUBLIC): `DATABASE_URL, DIRECT_URL, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, INITIAL_GM_EMAILS`; validated with Zod at boot.

## Phases (each ends with a gate; do not start the next until it passes)
**1. Foundation + shell.** Scaffold; strict TS; ESLint; Prisma schema + raw-SQL migration (schema.md); Clerk middleware + custom session claim; `lib/auth` (`withAuth`, lazy `User` upsert, inactive reject, role from claim, deny-by-default); `lib/permissions` (ROLES verbatim + `menu.edit`, `users.manage`, `data.admin`, `brands.edit`); repository layer with required `visibleBrandIds(user)`; error format `{error:{code,message,details?,requestId}}`; structured logging; **real UI shell** (legacy `legacy.css` + `print.css`, sidebar/header/`#acts` slot, Toast & Modal contexts, `<Perm>`/`usePerm`, brand palette ported + golden-tested for 14 brands); CI (typecheck, lint, test, build, prisma validate); empty Vercel deploy.
 Gate: CI green; palette matches legacy for all brands; deploy reachable; sign-in works.
**2. Costing & production domain.** `src/domain/costing` line-for-line (D-10); `domain/production` (reqExpand + conversion-aware valuation, flags, reconciliation); `domain/recipes/graph.ts` (`assertAcyclic`, used by editor + importer). Tests: golden diff all 321 cards (exact), plus **synthetic priced cases** (sp=100 invariants: totalCost = food + 0.5·sp, vatPrice = 1.15·sp, suggest = food/0.3), yield/yp matrix (y 0,0.5,10,11; yp 0/null/15), null price, needConv, wrong-direction factor, nested sub 1.15 once, cycles, depth-5 truncation visible, reprice propagation, requisition-vs-card reconciliation.
 Gate: 0 mismatches; coverage on `src/domain` ≥ 95%.
**3. Data layer + seed + vertical slice.** `prisma/seed.ts` (idempotent upserts, one transaction on `DIRECT_URL`, `SeedRun` checksum, abort if audit rows exist) → post-seed verification suite (schema.md) → ingredients/recipes/cost APIs → Items + Recipe list/editor on the real shell → save → reload → cost == golden.
 Gate: verification suite green on a Neon branch; round trip proven.
**4. Authorization & integrity hardening.** Permission matrix (6 roles × all endpoints), brand-IDOR suite (nested line codes, PATCH brandId needs both brands, 404 for out-of-scope), lock TOCTOU, optimistic-concurrency 409 tests, cycle race test (advisory lock), field-level auth for Finance PATCH, "every route is `withAuth`-wrapped" meta-test, audit-in-transaction with fresh-Clerk role snapshot, DB audit-immutability test, lock gate + GM override (D-29), price history + `costAtLock`.
 Gate: all authz tests green; `/security-review` clean.
**5. Full UI port** (visual parity). Order: Brands → Dash → Items → Recipes → Edit/Locked + recipe card print → Conv → Plan/Menu editor → Prod → Req → Prep → Yields → Settings → Audit → Health → Backup → Users (Clerk invitations). One screen = JSX with identical markup/classes; server page + client component; Esc/focus-trap/aria added without pixel change. Visual baselines: static server, Chromium pinned, 1440×900 (+768 informational), `addInitScript` seeds `golden/state.json` into legacy localStorage with a signed-in GM, frozen clock, transitions off, route via `go()`, states (modal, toast, selbar, pages 1–2, locked card); print via `emulateMedia('print')` + `page.pdf()` + `pdftoppm` + pixelmatch (~0.1%); plus a unit test that blob print documents contain the `.pc`/print rules.
 Gate: every screen under threshold; new Users/Menu screens reviewed by eye.
**6. Import/export/XLSX/print flows.** Browser-side XLSX/CSV reader/writer (port, fuzz, zip-bomb/row caps, worker), dry-run → chunked commit with hash, `yp`/`buffer` columns (D-17), CSV-injection neutralisation, production CSV implemented, bulk lock fixed, backup/restore (chunked, direct URL), price-list import with variance flagging.
 Gate: export→import round trip equal on golden; XLSX parity with legacy outputs.
**7. Deploy & verify.** Neon branch/PITR before migration; prod seed; Vercel prod; smoke tests per MEGA_PROMPT §35; second-device persistence; rollback rehearsal; `/engineering:deploy-checklist`; V1.1 backlog via `/engineering:tech-debt`.

## Review practice
Fresh-context reviewer agents (`/code-review`, `/security-review`, `/simplify`) at every phase gate; ADR for any divergence from legacy before coding it.

## Blockers needing user action
- Create Neon/Vercel Postgres + Clerk app; paste keys into `.env` (never committed).
- In Clerk: customize session token with `{"role":"{{user.public_metadata.role}}"}`; enable email invitations.
- Confirm UI wording changes in D-41 before Phase 5.
