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
typecheck, lint, prettier, `npm test` pass; DB tests on a throwaway local Postgres 18 (D-92; never on Neon, never `production`); golden diff still exact (or the row says why not); authz-matrix updated for new endpoints; `docs/PROGRESS.md`, `docs/API.md` and other affected docs updated in the same change; anything skipped reported. `/code-review` (and `/security-review` once the repo is on GitHub) at each feature's gate.

## Feature log
| Feature | Decision | Status |
|---|---|---|
| Dashboard analytics v2, slice 1: filters (brand/site/date), Menu Matrix, margin-at-risk / Pareto / unpriced / over-target, filtered export | D-65…D-67 | built, gates green (2026-10-10) |
| Dashboard slice 2a: clients entity + client in the production key (migration 0003) | D-68, D-71, D-72 | merged to `main` (`212e79f`), gates green; migration 0003 on `dev` and `production` |
| Dashboard slice 2b: stock tables, API, Stock screen (migration 0004) | D-69, D-72, D-73 | merged to `main` (`212e79f`), gates green; migration 0004 on `dev` and `production` |
| Dashboard slice 2c: stock upload (dry-run/commit) | D-73 | merged to `main` (`212e79f`), gates green (2026-10-11) |
| Dashboard slice 2d: Theoretical vs actual panel + Client filter + export | D-74, D-82 | merged to `main` (`759e300`), gates green (2026-10-11); strings approved |
| Dashboard redesign: tabs and overview, histogram, incomplete-card note, Ingredients KPI by brand | D-84 | merged to `main` (`b41f684`), gates green (2026-10-11); not checked in a browser; architect data review requested; new strings approved by Omer 2026-10-12 |
| Dashboard slice 2e: stock in backup/restore, Data Health, site rename carries stock | D-75, D-76, D-83 (D-77 = accepted gaps) | merged to `main` (`eb7fe82`), gates green (2026-10-11); strings approved |
| Dashboard slice 3: three-stage yield (migration 0007) | D-70, D-85 | merged to `main` (`82ccf36`), gates green (2026-10-11); strings approved |
| Users: pending invites, revoke, edit access, Select all brands (migration 0005) | D-78…D-81 | merged to `main` (`212e79f`), gates green (2026-10-11); migration 0005 on `dev` and `production` |
| Backup & Export: Import templates card (price list, recipe, stock counts, stock receipts) | D-86 | built, gates green (2026-10-11); layout, content and strings approved by Omer; checked in the browser as GM on `dev` |
| Rate limiting (429): slice 1 limiter core + migration 0008 + withAuth hook; slice 2 route tagging + meta-test + budget replay; slice 3 browser handling | D-87…D-90 | plan approved by Omer 2026-10-12; slices 1-2 committed (`48ca819`); slice 3 committed (`3534e01`), gates green, strings reviewed by Opus on Omer's instruction; migration 0008 on `production`; 429 checked live on `dev` |
| Factory-floor ergonomics (screen-only CSS, select-on-focus numeric inputs, Production day steppers and Enter-to-next, Backup/editor button order) | D-61 | merged to `main` from a stash (2026-10-12), typecheck/lint/unit tests green, DB suite not run; checked in the browser as GM on `dev` (Production, editor, Backup); new strings are only the aria-labels "Previous day" / "Next day" |
| DB tests on a local Postgres 18 instead of Neon branches (CI service container, local Docker) | D-92 | done 2026-10-12: 155/155 DB tests in ~20 s locally; CI `db` job green on GitHub (run 38251599473, about 1 min) |
| Default yield stages per raw material: migration 0009, Items form + Yield column, prefill of new lines, "Save to raw material", import/export/backup | D-93…D-96 | built 2026-10-13, gates green (typecheck, lint, prettier, 904 tests incl. DB on local Postgres 18); migration 0009 on `dev` (2026-10-13), **not yet on `production`**; checked in the browser as GM on `dev` (Items form and Yield column, prefill, Save to raw material, clear, bad value 400); strings pending Omer's approval |
| Add-recipe improvements, slice A1 (+ A2 Export card, D-98): Stock class (Dry/Raw/Subrecipe) field + Browse filter, 6 blank rows on a new card (migration 0010). Next: A2 single-card export, then revisions + dated prices + costing by date + same-code dialog | D-97, D-98 | A1 built 2026-10-13, strings approved, gates green (typecheck, lint, prettier, unit and DB tests on local Postgres 18); migration 0010 on the local container only, **not on `dev` or `production`**; not checked in a browser; strings pending Omer's approval |
| Dashboard slice 4 (optional): menu-mix shift, price-change impact, locked-card drift | — | proposed |
