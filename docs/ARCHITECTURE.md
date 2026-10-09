# ARCHITECTURE — target system design (authoritative; derived from DECISIONS.md)

## 1. Stack & layout
Next.js (App Router) + TypeScript strict · Prisma 6 · PostgreSQL (Neon) · Clerk · Vercel · Zod · Vitest (+fast-check) · Playwright + pixelmatch. No Python, no Tailwind/UI kit, no Clerk Organizations, no global client store, no localStorage persistence.
```
src/
  app/                 routes (Server Components fetch; Client Components for interaction); app/api/** route handlers
  components/          layout (shell), shared (Modal, Toast, Perm), per-feature client components
  domain/              PURE TS (no React/Prisma/Clerk/browser): costing, production, recipes (graph, codes), ingredients, menu-plans, dashboard
  data/                static data: yield-ref, sections, plan-alias (typed from prisma/seed-data/*.json)
  lib/                 auth (withAuth, getCurrentUser, requirePermission), permissions (ROLES), db (prisma client, repositories), validation (zod schemas), audit, print (html builders), brand (palette), xlsx, utils, env.ts (zod-validated env)
  styles/              legacy.css (verbatim), print.css
prisma/                schema.prisma, migrations (incl. raw SQL), seed.ts, seed-data/*.json
public/assets/         logos extracted from legacy
legacy/ golden/ tools/ read-only oracles + generators
```
Layering rule: route handler → `withAuth` → Zod validation → application function in `domain/`+repository → Prisma transaction → audit (same transaction) → response. Route handlers hold no business logic.

## 2. Request pipeline & auth
1. Clerk middleware validates the session. `withAuth({perm?, brand?})` wraps **every** handler (a meta-test enumerates route files and fails on any unwrapped export).
2. Resolve app `User` via `upsert({where:{clerkUserId}})` (retry on P2002); provision lazily on first request. **Reject if `User.active=false`.** Backstop for Clerk bans.
3. Role: custom session claim `{"role":"{{user.public_metadata.role}}"}` for UI gating/read speed (≤60 s staleness on role *changes* accepted). **Users-tab writes and last-GM checks re-read Clerk** (`clerkClient.users.getUser`). Role missing/invalid → **403 "pending"**, never viewer. `User.lastRoleSeen` is diagnostics only.
4. `INITIAL_GM_EMAILS` (server-only): if the Clerk **verified** primary email matches and no role is set, write `publicMetadata.role='gm'` to Clerk (idempotent); treat as gm for that request.
5. Permission check via central `can(role, perm)` (ROLES from legacy + `menu.edit`; `*` for gm). Client `can()`/`<Perm>` is cosmetic only.
6. Brand/resource check: repositories **require** `visibleBrandIds(user)` (GM = all; others = `UserBrandAccess`; none → empty). Fetch by id then check brand; out-of-scope → **404**. PATCH brandId needs access to old and new brand. Lines referencing ingredients (`ItemBrandScope`) or sub-recipes must be visible to the caller; unknown legacy codes tolerated only on unchanged lines.
7. Zod validation (all numbers `.finite()`; null price never → 0; qty ≥ 0; `y` in (0,10] else 1; `yp` null or [0,1000]; output > 0; strings trimmed/max length; uom/unit allowlist warns on import, rejects in editor).
8. Domain operation in `prisma.$transaction`; re-check lock status **inside** the transaction (`updateMany where status='DRAFT'` or `FOR UPDATE`); optimistic concurrency `version` (mismatch → 409); cycle check under `pg_advisory_xact_lock`.
9. Audit row in the same transaction: actor from session, `userNameSnapshot`, `roleSnapshot` from the fresh Clerk read.
10. Response. Error shape `{error:{code,message,details?,requestId}}`; 400 validation, 401 no session, 403 permission/inactive/pending, 404 not found/out-of-scope, 409 conflict/cycle/duplicate code/last GM, 413 too large, 422 business rule (e.g. lock gate), 429 rate limit, 500 no internals. Structured JSON logs `{reqId,clerkUserId,route,status,ms}` — never bodies/photos.
Rate limits (Upstash or Vercel firewall) on import, export, photo, user-management routes (~10/min/user).

## 3. Permissions (central, in code)
Legacy ROLES verbatim (see docs/legacy/05 §4) + `menu.edit` (gm, cc). GM-only (`*`): `users.manage`, `data.admin`, `brands.edit`, plus anything not listed. Field-level auth: a Finance PATCH on a recipe may change only price fields (`recipe.price`); ingredient purchase prices need `items.edit`; menu-plan price (`setMenuPrice`) needs `items.edit` (legacy) — see API table. Production/pax writes: `recipe.edit` (D-32). Reads: authenticated + brand scope; CSV/XLSX/export endpoints: `export`.

## 4. Users tab & Clerk integration
GM invites by email (`createInvitation` with `publicMetadata.role`), assigns brands (`UserBrandAccess`), changes role (Clerk metadata), bans/unbans (`banUser/unbanUser`, mirrored to `User.active`), deletes (soft-delete app `User`, then `deleteUser`). Protections: not the last active GM; not yourself (no self role change/suspend/delete); enforced with Clerk re-read + `pg_advisory_xact_lock`. Order: check → Clerk call → DB update → audit; on DB failure after Clerk success, compensate and log; lazy re-sync from Clerk (`banned`, role) on login; no webhooks in V1. A non-GM with zero brand rows sees nothing (UI says so).

## 5. Data access & costing performance
Load catalog with 3 queries (ingredients+conversions, recipes+lines **without photo**, settings), build Maps, run the pure `cost()` over all 321 recipes (ms). Cache the loader with `unstable_cache` tag `catalog`; every mutation of ingredients/recipes/conversions/settings calls `revalidateTag('catalog')`; brand filtering applied after the cache read. No stored cost column. Do not memoize `subUnitCost` across paths (cycle semantics are path-dependent). Photos fetched lazily per recipe from `RecipePhoto`.

## 6. Serverless / Vercel
Runtime `nodejs`. Runtime DB URL = pooled (`?pgbouncer=true&connection_limit=1`); `DIRECT_URL` for migrate, seed, import/restore routes (interactive transactions with raised `timeout`/`maxWait`; set `maxDuration`). Request body limit ~4.5 MB → photos client-downscaled (~300 KB; Zod caps data URL ≈400 KB; 1 MB DB cap), imports parsed in the browser and sent as ≤500-row chunks with a server hash, restore chunked. Exports are responses (stream CSV; XLSX generated in browser from API JSON so `export` and brand scope are enforced at the data endpoint). Print is browser-native (`window.print`, Blob documents); `page.pdf()` is used only in local tests (Chromium doesn't fit in a function).
Secrets: only env vars; validate with Zod at boot; `INITIAL_GM_EMAILS` has no `NEXT_PUBLIC`.

## 7. Database operations
See `schema.md`. Forward-only migrations (expand/contract); Neon branch/PITR point before every prod migration; one Neon branch per CI run/preview for tests. Seed: upserts by code in a single transaction on `DIRECT_URL`, `SeedRun(version,checksum)`, never `deleteMany`, abort if audit rows exist; chunked `createMany` for lines. Prod data load script behind `--confirm`.

## 8. Concurrency rules
`version` on Recipe, Ingredient, CostSettings, Menu (PATCH carries expected version; `updateMany where id,version`; 0 rows → 409). Recipe save = replace lines/method inside one transaction. Last-write-wins for MenuCell edits via Menu version only on structure, ProductionEntry, MenuPax (upserts).

## 9. Deletion & references
Recipes soft-deleted (`deletedAt`), code reusable (partial unique index), restore re-checks collision. Ingredient deletion blocked if referenced by any line/menu cell; deletes its conversion. Recipe code rename cascades to RecipeLine.code and MenuCell.code in one transaction (D-33). Brand deletion blocked while recipes exist. Menus deactivated rather than deleted.

## 10. Where each concern is documented
Behavior of the original → docs/legacy/*. Decisions → DECISIONS.md. Schema → schema.md. Endpoints → docs/API.md. Tests → docs/TESTING.md. UI strategy → docs/UI_PORT.md. Setup/ops → docs/RUNBOOK.md. Progress → docs/PROGRESS.md.
