# ISFC Food Costing System — migration project
Migrating the single-file legacy HTML app (`legacy/app.html`) to Next.js + TypeScript + PostgreSQL (Neon, `pg`, plain SQL) + Clerk + Vercel, preserving behavior and UI except where `DECISIONS.md` says otherwise. **The migration is complete; from Phase 8 new features are added as Omer describes them (`docs/FEATURES.md`, `/feature-team`).** **No deadline; quality gates only.**

## How to resume work in a fresh session (no chat history needed)
Read in this order:
1. `CLAUDE.md` — non-negotiable rules.
2. `docs/PROGRESS.md` — what is done, what is next, open items. Then `docs/FEATURES.md` — how new features are added (feature team, brief, gates, feature log).
3. `DECISIONS.md` — every approved/pending decision (overrides the two spec files).
4. `SOURCE_OF_TRUTH.md` then `MEGA_PROMPT.md` — original spec/instructions (read the AMENDMENTS block at the top first).
5. `docs/ARCHITECTURE.md`, `schema.md`, `docs/API.md` — target design.
6. `docs/legacy/01…05, 09` + `DISCOVERY_FINDINGS.md` — exact behavior of the original (with legacy line numbers).
7. `docs/legacy/FUNCTION_INDEX.md` (exact legacy line numbers; other docs' line numbers can drift by a few lines), `docs/TESTING.md`, `docs/UI_PORT.md`, `docs/RUNBOOK.md`, `FUNCTION_MAP.md` — how to verify, port UI, operate.

## Map
| Path | What |
|---|---|
| `legacy/app.html` | frozen original (read-only oracle) |
| `golden/state.json`, `golden/costs.json` | effective post-boot data and legacy cost results (read-only oracles) |
| `db/seed-data/*.json` | seed inputs split from golden + constants (menu plan, yield ref, sections, plan alias, seed issues…) |
| `public/assets/*.png` | logos extracted from legacy |
| `tools/*.js` | generators for the above (`npm i` inside `tools/`) |
| `db/migrations/*.sql` | the database schema (hand-written SQL, source of truth) — applied with `npm run db:migrate` |
| `scripts/migrate.mjs` | migration runner (unpooled Neon connection) |
| `src/` | Next.js app, `domain/` (pure costing/production), `lib/` (auth, db, images, permissions, palette) |
| `tests/` | unit tests; `tests/db/` needs `TEST_DATABASE_URL` (see docs/RUNBOOK.md §4a) |
| `vercel.json`, `neon.ts`, `.neon` | deploy region (`fra1`), Neon project config/link |
| `docs/` | architecture, API, testing, UI port, runbook, progress, legacy behavior |
| `ISFC_Costing_System_v8.7.html` | original upload (same as `legacy/app.html`) |

## Status
See `docs/PROGRESS.md` (phase checklist and open items). Rule: update docs in the same change as the code; any behavior divergence from legacy gets a `DECISIONS.md` row first.
