# RUNBOOK — setup, environments, deploy, rollback
(Project is not scaffolded yet; commands below are the target workflow once Phase 1 creates `package.json`.)

## 1. Prerequisites
Node 24 (tested 24.19), npm 11, Docker or a Neon account for Postgres, a Clerk application, a Vercel project. Windows 11 dev machine (Git Bash / PowerShell). The repo is **not a git repository yet** — run `git init` at the start of Phase 1 and commit docs + oracles first (`golden/`, `legacy/`, `prisma/seed-data/`, `public/assets/`, `tools/` without `node_modules`).

## 2. Environment variables (`.env`, gitignored; validated by `src/lib/env.ts` with Zod, fail fast)
| Var | Purpose | Notes |
|---|---|---|
| DATABASE_URL | pooled Neon URL for runtime | `?pgbouncer=true&connection_limit=1` |
| DIRECT_URL | direct URL for migrate/seed/import/restore | never used by normal request handlers |
| NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY | Clerk publishable key | |
| CLERK_SECRET_KEY | Clerk secret | server-only |
| INITIAL_GM_EMAILS | comma list of emails granted GM on first login (verified emails only) | server-only |
| (optional) UPSTASH_REDIS_REST_URL/TOKEN | rate limiting | |
The user supplies the Vercel/Neon/Clerk keys by pasting them into `.env`. Never print or commit them.

## 3. Clerk configuration (manual, once)
- Session token customization: `{"role": "{{user.public_metadata.role}}"}`.
- Roles live in `publicMetadata.role` ∈ `gm|cc|fin|chef|cook|viewer`. No Clerk Organizations.
- Enable email invitations; allow sign-in by email (+ password or magic link per org policy).

## 4. Database workflow
- `prisma migrate dev` (local/Neon branch), `prisma migrate deploy` with `DIRECT_URL` in CI/prod. Raw SQL (partial unique index, CHECKs, audit triggers) lives in migrations (see schema.md). Forward-only; **before every prod migration take a Neon branch / note the PITR timestamp**.
- Seed: `prisma/seed.ts` reads `prisma/seed-data/*.json` (do not modify them; regenerate via `tools/`). Single transaction, `SeedRun` checksum, aborts if audit rows exist. Run the post-seed verification suite after every seed (docs/TESTING.md §2).
- Tests use a separate Neon branch/Docker DB, never prod.

## 5. Regenerating oracles (only when the legacy source changes)
`cd tools && npm i`, then `node dump-golden.js`, `node dump-costs.js`, `node extract-assets.js`, `node extract-seed.js`. Review the diff in `golden/` and `prisma/seed-data/` — changes mean the data contract changed and DECISIONS.md must say why.

## 6. Deploy (Vercel)
Preview deployment per PR with its own Neon branch. Prod: Neon branch backup → migrate (DIRECT_URL) → seed (first time only, `--confirm`) → deploy → smoke tests (login, role handling, ingredient price edit, recipe edit/cost, lock/unlock, menu/production/requisition, audit, export/import, print) → second browser/device persistence check. Use `/engineering:deploy-checklist`. Set `maxDuration` on import/restore/seed routes. Rollback: redeploy previous Vercel build; for data, restore Neon branch/PITR; migrations are forward-only so schema rollback = restore.

## 7. Operations
Structured logs (no bodies/photos); `requestId` returned on 500s. Rate limits on import/export/photo/user routes. Monitor `/api/health`. Back up: Neon PITR; plus admin JSON/CSV backup screen. Audit log immutable (DB triggers); never grant the app role UPDATE/DELETE/TRUNCATE on `AuditLog`; run migrations under a separate owner role.
