# FEATURES — how new features are added (Phase 8 onward)

The app matches the legacy sample (Phases 0–7). From here Omer describes **new features**; the goal changes from "copy the sample exactly" to "integrate what Omer asks for, safely". This file is the process; `CLAUDE.md` holds the rules; `DECISIONS.md` records every feature.

## What stays frozen, what is now open
| Stays | Now open |
|---|---|
| `legacy/**`, `golden/**` as a **regression baseline**: the 321-card golden diff stays exact unless a feature intentionally changes costing (then a `DECISIONS.md` row names the fields) | New screens, widgets, endpoints, tables, columns, reports |
| Costing = pure TS in `src/domain/costing`, JS doubles, no new rounding (round only at display/export); null price ≠ 0 | Wording and UI for **new** features (tell Omer which strings are new); existing wording changes only on request, with a row |
| Neon + `pg` + plain SQL, schema changes = new numbered migration; Clerk only; `withAuth` on every route; brand scoping via `visibleBrandIds`; DB is source of truth | New dependencies (UI kits, chart libs, queues) — allowed **only** with a `DECISIONS.md` row, and the optimisation engineer's size/perf note |
| Secrets only in `.env`; docs updated in the same change; gates before "done" | Existing legacy look is the default visual language; new classes only where no legacy class fits |

## The feature team (`.claude/agents/`)
Every time Omer discusses a new feature, run `/feature-team <description>` (skill: `.claude/skills/feature-team`). It spawns, in parallel and read-only:

`architect` (lead) · `backend-engineer` · `database-engineer` · `optimisation-engineer` · `frontend-engineer` · `security-engineer` · `qa-engineer` · `domain-analyst`

Flow: **brief → parallel role proposals → architect synthesis → Omer decides → implement in slices → gates → docs/decision row → commit.** Nothing is implemented before Omer approves the plan.

## Brief template (filled from Omer's description; ask only what the code cannot answer)
```
FEATURE: <name>
WHY / WHO: <the decision it supports, which roles use it>
BEHAVIOUR: <what the user sees and does>
MUST NOT CHANGE: <existing behaviour to protect>
DATA: <new/changed data, sources>
OUT OF SCOPE: <explicit>
```

## Role proposal format
`ROLE / RECOMMENDATION / DETAILS (file:line) / REJECTED ALTERNATIVE / RISKS / OPEN QUESTIONS FOR OMER / EFFORT (S|M|L)`

## Architect's synthesis (what Omer gets back)
1. One recommended strategy, in 5–10 lines, with the conflicts between roles resolved and named.
2. Slices in build order, each with files touched, tests, and doc updates.
3. `DECISIONS.md` rows to add (D-64 onward), new permissions, migrations, new dependencies.
4. Perf target (a number) and how it will be measured.
5. Questions only Omer can answer.

## Definition of done (per slice)
typecheck, lint, prettier, `npm test` pass; DB tests on a throwaway Neon branch (never `production`); golden diff still exact (or the row says why not); authz-matrix updated for new endpoints; `docs/PROGRESS.md`, `docs/API.md` and other affected docs updated in the same change; anything skipped reported. `/code-review` (and `/security-review` once the repo is on GitHub) at each feature's gate.

## Feature log
| Feature | Decision | Status |
|---|---|---|
| Dashboard analytics v2, slice 1: filters (brand/site/date), Menu Matrix, margin-at-risk / Pareto / unpriced / over-target, filtered export | D-65…D-67 | built, gates green (2026-10-10) |
| Dashboard slice 2a: clients entity + client in the production key (migration 0003) | D-68, D-71, D-72 | built on Neon branch `slice-2a`, gates green; not yet on `dev`/`production` |
| Dashboard slice 2b: stock tables, API, Stock screen (migration 0004) | D-69, D-72, D-73 | built on branch `slice-2a`, gates green; not yet on `dev`/`production` |
| Dashboard slice 2c: stock upload (dry-run/commit) | D-73 | built, gates green (2026-10-11) |
| Dashboard slice 2d: Theoretical vs actual panel + Client filter + export | D-74, D-82 | built on branch `slice-2d`, gates green (2026-10-11); strings approved |
| Dashboard slice 2e: backup/restore, Data Health, site rename | D-75, D-76, D-77 | approved, not built |
| Dashboard slice 3: three-stage yield | D-70 | approved, not built |
| Users: pending invites, revoke, edit access, Select all brands (migration 0005) | D-78…D-81 | built, gates green on branch `slice-2a` (2026-10-11) |
| Dashboard slice 4 (optional): menu-mix shift, price-change impact, locked-card drift | — | proposed |
