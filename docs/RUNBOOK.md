# RUNBOOK — setup, environments, deploy, rollback
(Project is not scaffolded yet; commands below are the target workflow once Phase 1 creates `package.json`.)

## 1. Prerequisites
Node 24 (tested 24.19), npm 11, a Neon account/project (Docker not needed), a Clerk application, a Vercel project. Windows 11 dev machine (Git Bash / PowerShell). The repo is **not a git repository yet** — run `git init` at the start of Phase 1 and commit docs + oracles first (`golden/`, `legacy/`, `prisma/seed-data/`, `public/assets/`, `tools/` without `node_modules`).

## 2. Environment variables (`.env`, gitignored; validated by `src/lib/env.ts` with Zod, fail fast)
| Var | Purpose | Notes |
|---|---|---|
| DATABASE_URL | pooled Neon URL (host has `-pooler`) for the running app | written by `neon link` / `neon checkout` / `neon deploy` into `.env.local` |
| DATABASE_URL_UNPOOLED | direct Neon URL for `scripts/migrate.mjs`, seeding, import/restore | never used by normal request handlers |
| NEON_BRANCH | branch the local env points at | informational |
| NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY | Clerk publishable key | |
| CLERK_SECRET_KEY | Clerk secret | server-only |
| INITIAL_GM_EMAILS | comma list of emails granted GM on first login (verified emails only) | server-only |
| (not used) UPSTASH_REDIS_REST_URL/TOKEN | rate limiting is in Neon (D-87), no vendor needed | |
Neon variables are written to `.env.local` by the Neon CLI; the user pastes Clerk keys and `INITIAL_GM_EMAILS` into `.env.local`. `.env*` is gitignored. Never print or commit secrets.

### Neon project (moved to a new Neon account 2026-10-12, D-91)
Project `isfc-costing` (`dark-credit-83519706`), org `org-empty-wave-59058729`, free plan, region `aws-eu-central-1` (Frankfurt), Postgres 18. Branches: `production` (default, `br-curly-waterfall-b9ib4yqh`; migrations 0001–0008 and the seed applied 2026-10-12); `dev` (`br-purple-bonus-b9blhb4x`, child of `production`, created 2026-10-12 with `neon checkout dev --create` right after the seed, so it holds the same data). On this Windows machine PowerShell blocks `.ps1` scripts, so type `npm.cmd` and `neon.cmd` (the CLI was installed with `npm.cmd i -g neon@latest`). The free plan allows **5 GB of data transfer a month**; going over it blocks every query on every branch until the next month (that is what retired the first project, below). Keep the full DB suite and long local dev sessions off `production`, and watch Usage in the console. The first project (`old-butterfly-59479439`, org `org-cool-shadow-74874401`, old account) is retired: over its transfer quota on 2026-10-12, kept untouched, not deleted. Repo linked with `.neon` (gitignored); `neon.ts` is `defineConfig({})` (no policy). **Vercel functions run in `fra1`** — `vercel.json` sets `"regions": ["fra1"]` (in the repo); when the Vercel project is created, confirm Settings → Functions → Region shows Frankfurt and that Fluid compute is enabled (default for new projects), so each query is a ~1–3 ms hop. CLI: `npm i -g neon@latest`, `neon login` (browser OAuth), `neon link --project-id dark-credit-83519706 --branch production -y`, `neon checkout <branch> [--create]` (switches branch and rewrites `.env.local`), `neon deploy`, `neon branches list`. `neon mcp -y` installed the Neon MCP server (and minted an account-wide API key, revocable with `neon api-keys revoke <id>`); `neon skills -y` installed Neon skills under `.claude/skills/`.

## 3. Clerk configuration (manual, once)
- Session token customization: `{"role": "{{user.public_metadata.role}}"}`.
- Roles live in `publicMetadata.role` ∈ `gm|cc|fin|chef|cook|viewer`. No Clerk Organizations.
- Enable email invitations; allow sign-in by email (+ password or magic link per org policy).

## 4. Database workflow
- Access: `pg` + hand-written SQL (`src/lib/db`). No ORM, no codegen (D-50). Rows are snake_case in SQL and camelCase in TS via `camelRow`.
- Migrations: numbered files `db/migrations/NNNN_name.sql` (never edit an applied one; checksum is enforced). `npm run db:migrate` applies pending files over `DATABASE_URL_UNPOOLED` (each in its own transaction, recorded in `schema_migrations`); `npm run db:status` lists applied/pending. Forward-only. **Before every production migration**: `neon checkout dev`, run the migration there first, then create a branch off `production` (or note the PITR timestamp), then migrate `production`.
- **Catalog cache after a seed or direct database change (D-99):** the costing screens read a cached catalog that only an in-app write clears. After seeding, restoring a database or editing rows by hand, bump the version in `src/lib/db/catalog-cache.ts` (`['catalog-data','v2']` to `'v3'`) and deploy, or the screens keep showing the old data (production showed 0 cards on 2026-10-13 and a new key fixed it; how the cache came to be empty was not observed). The 6 h expiry is only a safety net.
- **Migration 0012 (dated prices, D-107)** only adds a column with a default and rebuilds one index; it can go on `production` before or after the code that uses it. **Never run a blanket `npm run db:migrate` when the working tree holds another stream's unreleased migration** (it applies that one too; this happened with 0013 on 2026-10-13): apply your own file only, or make sure every pending file is meant to go.
- **Migration 0011 (card revisions) must be on `production` before the code that reads `recipe.revision` is deployed** (D-101); it only adds columns and tables, and existing cards become revision 1 effective from their creation day.
- **Production migration, as done 2026-10-13 (0009, 0010; the backup step above was NOT done that day: no branch off `production` and no restore time was noted, because both migrations only add columns; do it next time):** `neon.cmd checkout dev`, `npm.cmd run db:status`, `npm.cmd run db:migrate`; then `neon.cmd checkout production`, `npm.cmd run db:status`, `npm.cmd run db:migrate`; then **`neon.cmd checkout dev`** again (checkout rewrites `.env.local`, so a forgotten switch leaves every later local command pointing at production). Migrate before pushing code that reads a new column, because Vercel deploys on push.
- Branches: `dev` for local work and seeding; per-run test branches (`neon checkout ci-<run> --create`, 7-day TTL) for integration tests; `production` only receives reviewed migrations and the single audited seed. Switch with `neon checkout <name>` (it rewrites `.env.local` — check `NEON_BRANCH` before running anything destructive).
- Seed: `npm run db:seed` (`scripts/seed.mjs` → `src/lib/seed/seed.ts`) reads `db/seed-data/*.json` (do not modify them; regenerate via `tools/`), single transaction on the unpooled URL, `seed_run` checksum, aborts if audit rows exist. Run the post-seed verification suite after every seed (docs/TESTING.md §2).
- TLS: Neon URLs say `sslmode=require`; `pg` would warn that its meaning is changing. `src/lib/db/conn.ts` (app) and `scripts/migrate.mjs` rewrite `require|prefer|verify-ca` to `verify-full` (what `pg` does today, and Neon's certificates are publicly trusted), so there is no warning and no behavior change. Any new script that opens a `pg` connection must do the same (use `normalizeConnectionString`).
- Tests use a separate Neon branch, never `production`.

### 4a. Database tests and CI (D-92: local Postgres, not Neon)
- Local: `docker run -d --name isfc-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=isfc -p 127.0.0.1:5433:5432 postgres:18` once (then `docker start isfc-pg`), and in bash: `export DATABASE_URL_UNPOOLED=postgresql://postgres:postgres@127.0.0.1:5433/isfc NEON_BRANCH=local-test TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/isfc; npm run db:migrate && npm run db:seed -- --confirm && npm run test:db`. 155 tests, about 20 s. Without `TEST_DATABASE_URL` the DB tests are skipped, so plain `npm test` stays offline. Every schema test runs inside a transaction that is rolled back; the client tests clean up the rows they commit.
- CI (`.github/workflows/ci.yml`, job `db`): a `postgres:18` service container that lives only for the job; `npm run db:migrate` twice (the second must print "database is up to date"), `npm run db:seed -- --confirm` (the DB tests need the seeded data and vitest runs files in parallel), then `npm run test:db`. No secrets, so it also runs for fork PRs.
- Why not Neon (2026-10-12): on the first project, CI test branches and local test runs against `dev` were ~98% of 6.7 GB data transfer in three days (live `production` used 0.08 GB), which went over the free 5 GB quota and locked the project (D-91). The GitHub variable `NEON_PROJECT_ID` and secret `NEON_API_KEY` are no longer used by CI.

## 5. Regenerating oracles (only when the legacy source changes)
`cd tools && npm i`, then `node dump-golden.js`, `node dump-costs.js`, `node extract-assets.js`, `node extract-seed.js`. Review the diff in `golden/` and `db/seed-data/` — changes mean the data contract changed and DECISIONS.md must say why.

## 6. Deploy (Vercel)
Preview deployment per PR with its own Neon branch. Prod: Neon branch backup → `npm run db:migrate` against production (DATABASE_URL_UNPOOLED) → seed (first time only, `--confirm`) → deploy → smoke tests (login, role handling, ingredient price edit, recipe edit/cost, lock/unlock, menu/production/requisition, audit, export/import, print) → second browser/device persistence check. Use `/engineering:deploy-checklist`. Set `maxDuration` on import/restore/seed routes. Rollback: redeploy previous Vercel build; for data, restore Neon branch/PITR; migrations are forward-only so schema rollback = restore.

## 7. Operations
Structured logs (no bodies/photos); `requestId` returned on 500s. Rate limits on import/export/restore/photo/user routes (D-87…D-89, table `rate_limit`; a refused request shows as `status 429` with `rl:{cls,retryAfter}` in the request log line, and `rate_limit_store_down` warnings mean the counter store did not answer). Monitor `/api/health`. Back up: Neon PITR; plus admin JSON/CSV backup screen. Audit log immutable (DB triggers); never grant the app role UPDATE/DELETE/TRUNCATE on `audit_log`; run migrations under a separate owner role.

## 8. Added in Phases 3–6 (2026-10-09)
- **Migration `0002_restore_staging.sql`** (staging table for chunked restores) is applied to Neon `dev` only. Before deploying, run `npm run db:migrate` against `production` after the usual branch/PITR step (Phase 7).
- **Active brand** is the `isfc_brand` cookie (httpOnly, 180 days, validated against the user's brands on every request).
- **Backup / restore** (Backup & Export, GM only): *Download full backup* assembles one JSON file from `GET /api/export/backup` parts (data + base64 photos/logos). *Restore* uploads the file in 1.2 MB slices to `restore_chunk`, runs a **dry-run** (the restore is applied and rolled back, so every constraint is exercised) and only then asks for the final click; the commit is one transaction on `DATABASE_URL_UNPOOLED`. Cards missing from the backup are soft-deleted, ingredients missing from it are kept, the audit log is never changed. **Try a restore on a throw-away Neon branch first** (`neon branches create --parent dev`), never first on production. Abandoned uploads are pruned after a day.
- **Imports** (price list ≤ 500 rows per request, recipes ≤ 100 cards per request) are parsed in the browser; the server re-validates everything and refuses a commit whose hash differs from the dry-run.
- **Visual smoke**: `npm run preview:screens` (see docs/TESTING.md §8).
