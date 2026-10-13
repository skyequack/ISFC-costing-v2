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
| Add-recipe improvements, slices A1 + A2: Stock class (Dry/Raw/Subrecipe) field + Browse filter, 6 blank rows on a new card (migration 0010), **Export card** (one card as Excel in the upload layout) | D-97, D-98 | pushed to `main` (`46404c2`, 2026-10-13); gates green (typecheck, lint, prettier, 746 unit/UI tests, 168 DB tests on local Postgres 18); migrations 0009 and 0010 on `dev` and `production`; checked live as GM (Stock class dropdown and Export card button present on a card; the download itself and the 6 default rows on a new card were not exercised live); strings: the six Stock class strings approved by Omer 2026-10-13, "Export card" pending |
| Catalog cache stuck empty on production (live fix): key `catalog-data` v2 + 6 h expiry | D-99 | pushed (`a2b4546`), verified live 2026-10-13: Recipe Cards shows 321 cards |
| Add-recipe improvements, slices B1-B4 (B1 includes the same-code dialog): revisions with effective dates, dated ingredient prices, costing by date, same-code upload dialog, backup of both | D-100 (plan), D-101 (B1), D-102 onward | plan approved by Omer 2026-10-13 (D-100); **B1 built** (D-101: revisions, Start new revision, upload choice, unlock starts a revision; migration 0011); B2 dated prices, B3 costing by date, B4 backup/Data Health not started; see "Add-recipe improvements: design for B1-B4" below |
| Dashboard slice 4 (optional): menu-mix shift, price-change impact, locked-card drift | — | proposed |

## Add-recipe improvements: design for B1-B4 (feature-team review 2026-10-13; answers 2026-10-13; D-100, plan approved; B1 built as D-101)
Omer's client asked for: an auto-generated recipe code, a sub-category (dry / raw / subrecipe), 6 default ingredient rows, export one card to Excel then re-upload it with a "same code" choice (new code or update), and versioned recipes with effective from / to so costing is right by date. What the code already did: auto code (`nextCode`, the regenerate button), upload by code (a global "overwrite" choice, in place), a Menu / Sub-Recipe type. What was new: everything else.

**Built** (A1, A2: D-97, D-98): Stock class label and filter (Subrecipe derived from the type), 6 blank rows, Export card.

**Omer's answers (2026-10-13), the basis of D-100**
- A revision is made only by an upload that updates a code, or by a "Start new revision" button; autosave edits the live card.
- **A new revision starts the day it is saved (today). No date picker, no future-dated or scheduled revisions, no backdating.** A second update on the same day merges into that day's revision.
- A **locked card cannot be updated by upload**: unlock first. **Unlocking starts a new revision** (a draft starting today); the approved revision stays untouched.
- A revision stores **everything on the card except the photo** (header, lines, yields incl. three-stage, method, price, buffer, batch fields, lock state and `cost_at_lock`).
- Production days and requisition use the revision in force on the production date, **only locked revisions count**; a revision counts **from its start day** even if it is approved later (a Monday revision approved on Thursday also recosts Monday to Wednesday). A card that has **no locked revision at all** is costed as it is today (so nothing loses its cost; none of the 321 production cards is locked yet) and is **flagged with a warning**.
- Dashboard history uses the revision per production date; a parent follows its sub-recipe's revision for the same date; menus and plans use the current card.
- Ingredient prices are dated by the **day they are saved only** (no date field on the price editor or the price-list import); history before the first record uses the earliest known price or revision.
- Past months are recalculated from the data (no month-end snapshot); the legacy free-text "Sub Category" is kept; "today" means the **Asia/Riyadh** business day; dashboard range stays 366 days with a "narrow the range" error beyond 60 periods.

**Model**
- `recipe` keeps ONE live row per code: always the revision in force today (so code identity, `recipe_code_lower_live`, menus, lists, the editor and the cached catalog are untouched; no scheduling job, no cron exists on Vercel). Superseded revisions go to new `recipe_version` (header, lock state incl. `cost_at_lock`, method as text array, `origin` BUTTON | UPLOAD | UNLOCK, `CHECK effective_from < effective_to`, unique per `(recipe_id, revision)` and `(recipe_id, effective_from)`) and `recipe_version_line` (relational, not JSON, so a code rename keeps working: the D-33 rename cascade also updates archived lines). The live row gains `revision` and `effective_from`. Only "from" is stored; "to" is the next revision's "from" (both shown). Half-open `[from, to)`. Volume is about 1 000 revisions a year (a few MB).
- "Start new revision" freezes the card AS IT IS NOW as revision N and starts N+1 today; since autosave edits the live row, the button must be pressed before editing (the label says so). Same day: 409 "a revision already started today", button hidden. Cap 50 revisions per card.
- Dated prices reuse `ingredient_price_history` (add `effective_on date`, default today in Riyadh; backfill from `created_at`; index `(ingredient_id, effective_on, created_at)`); the existing writers already go through `addPriceHistory`, so the code change is small. Price on date d: after the last row use the live price; between rows the last row on or before d (null stays null); before the first row its old price (else new); no history = current price. `deleteIngredient` must also refuse when an archived revision line uses the code. Backup restore must append a price-history row when it changes a price (today it does not).
- The as-of resolver is a pure module (`src/domain/asof/`) that builds a catalog overlay and feeds the **unchanged** costing engine. Revision rule per card and date d: the newest LOCKED revision with from <= d; else the earliest locked; else the earliest of any status (never empty). A draft live revision is ignored for production while an older locked one exists. Costing runs once per **period** (days with no revision or price change). Fast path: if no card has history in the range, use the cached catalog (+1 statement); otherwise +2 more statements. Caps: 31 periods for a production month, 60 for the dashboard. Callers: production and requisition (`src/lib/screens/prod.ts`, `exports.ts`), dashboard (`dash.ts`, with a new daily production loader in `planning.ts`). Not dated (accepted gaps): the VAT panel and the cost settings (packaging, delivery, labour, ops). Dashboard cost and price are portion-weighted across periods, so they can differ from a per-period sum in the last digits.
- Upload dialog: a per-card `mode` (`update` | `new`) in the dry-run input (so it is in the hash); an existing code with no mode is action `exists` and blocks commit until chosen; `new` allocates a code with `nextCode`; an update needs `recipe.edit` as well as `recipe.create` (closes today's gap); a locked card stays `locked`. If the live revision already started today, the upload updates it in place; otherwise it archives the old state first.
- Routes: `POST /api/recipes/[id]/revisions` (body `{version}`, `recipe.edit`, new rate class `revision`, 60 per 10 min, not fail-closed; 404 out of scope, 422 locked or at the cap, 409 stale or same day), `GET /api/recipes/[id]/revisions` and `GET .../revisions/[n]` (scoped, read-only). Audit: "Started card revision" (code, revision n to n+1, from date, via button/upload/unlock). Unlock of a locked card starts the new revision in the same transaction.
- Backup stays version 1 with optional `recipes[].revision`, `effectiveFrom`, `revisions[]` and a chunked top-level `priceHistory[]`; restore replaces revisions with the cards and either restores price history or appends a `RESTORE` row for a changed price. Data Health: revision ranges contiguous; price-history tail equals `ingredient.price`; cards used in production with no locked revision.
- Proposed new strings (to be approved when B1 is built): "Start new revision", "Revision {n}", "In force since {date}", "Revisions", "Freezes this card as revision {n} and starts revision {n+1} today. Do this before you change the card.", "A revision already started today. Keep editing it.", "Revision {n} started", "Same code", "Generate new code", "Use this code to update", "A card with this code exists. Choose what to do.", "Updated in place (a revision already started today)", plus a "not approved" warning for cards with no locked revision.

**Slices and effort:** B1 revisions, button, history view, same-code dialog, unlock-starts-revision (migration 0011): M. B2 dated prices (migration 0012): S. B3 costing by date in production, requisition and dashboard: L. B4 backup/restore, Data Health, audit: M. Perf targets: no history in range +1 statement and under 5 ms; with history at most +3 statements and under 150 ms for up to 5 periods (estimates, measure with `SQL_TRACE=2`).

**Tests:** golden 321/321 through the as-of path with no history must be exact and the fast path equal to the cached catalog; half-open boundaries (d = from takes the new revision, d = to the next); before the first revision/price uses the earliest; null price stays null; same-day price changes use the last row; draft live revision means the previous locked one is used; a never-locked card still costs and is flagged; parent/sub combinations (sub changes on day X, parent unchanged; nested); rename cascade keeps an archived parent costable; ingredient delete guard; same-day upload updates in place and a second Start is 409; locked upload is `locked`; unlock starts a revision; hash includes `mode`; viewer 403 on update; two Starts give 201 + 409, upload racing a save and lock racing a Start lose cleanly; authz matrix rows and rate-class meta-test; v1 backup restores, revisions round-trip, price-history tail equals price; statement counts (fast +1, slow +3).

**Risks:** recosting past days when a revision is approved late (accepted); the Riyadh/UTC edge near midnight; history-tail drift from writers that bypass `addPriceHistory`; deleting a sub-recipe that archived parents still use; dashboard weighted averages not float-identical to a per-period sum.

**Not yet decided (small, asked when B1 starts):** exact wording of the revision screens and the warning.
