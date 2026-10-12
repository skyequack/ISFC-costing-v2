# Perf plan: card saves and request cost (condensed)

The 2026-10-10 design for making card saves fast. Most of it is built; this file keeps the results, the rules it set, and what is still open. The full design (per-statement tables, SQL sketches, test matrix T1–T10) is in git history (`git show d9f05e3:docs/PERF_PLAN.md`).

## Why saves were slow
Latency is network round trips (about 84 ms each from the dev machine to Neon eu-central-1; about 1–3 ms from Vercel `fra1`), plus the bytes moved. A name-only `PATCH /api/recipes/[id]` ran 17 statements, and every save reloaded the whole catalog (every ingredient and recipe line) to cost one card. The engine only reads codes reachable from the card's lines, so a card's cost depends only on the **transitive closure of its line codes**.

## Built (2026-10-10)
| Step | What | Where |
|---|---|---|
| R1 | Card, lines and method loaded in one statement under the row lock | `saveRecipe` / `loadForSave`, `src/lib/services/recipes.ts` |
| R2 | Graph/code advisory lock only when lines, code, type or brand change | same |
| R3 | All audit rows of a save, and the 10-minute "Edited card" collapse, in one statement | `auditInsertSql`, `src/lib/db/repo/audit.ts` |
| R4 | The card's cost closure (recursive CTE, `UNION` so cycles end) instead of the full catalog; unchanged `buildContext` / `buildCardView` | `loadCostClosure`, `src/lib/db/catalog.ts`; proof `tests/db/cost-closure.test.ts` (all 321 seed cards equal) |
| R5 | User row and brand scope in one query when the session token carries `role` | `attachScope`, `src/lib/db/scope.ts` (**no effect until the Clerk role claim is set**, RUNBOOK §3) |
| R6 | Version-checked `UPDATE` and the audit insert in one CTE statement (0 rows = 409) | `saveRecipe` |
| R8 | Scalar edits build the response from the loaded rows (no re-read) | `saveRecipeWithDetail`; `tests/db/save-path.test.ts` |
| client | Edits made while a save is in flight merge into one follow-up request (`sellingPrice` kept separate) | `EditScreen.tsx`; `tests/ui/screens.test.tsx` |

Result (live trace on `dev`): name-only PATCH 17 → 6 statements (2.5–3.4 s → about 0.9 s), lines PATCH 23 → 14 (up to 5 s → 1.7 s), GET card 10 → 4 (2.0 s → 0.7 s). Costs unchanged.

## Rules this plan set (keep them)
- Costing stays on the server: it crosses brands, so shipping the catalog to the browser would leak out-of-scope prices.
- No cached catalog inside a save: it is stale for the card just written (`bustCatalog()` runs after commit).
- Lock gate, recipe import and menu-day apply keep the full `loadCatalog(tx)` on purpose: the lock gate needs one snapshot of all prices.
- Lines are not folded into a CTE with their own `DELETE`: `UNIQUE (recipe_id, sort_order)` is not deferrable.
- Only `makeScope` builds a `BrandScope`; every route stays behind `withAuth`.

## Open
- **R7** per-instance cache of the user row and scope (TTL 5–10 s, invalidated on user and brand admin writes). **Needs a DECISIONS row:** D-35 says every request loads the user row and rejects inactive users. Saves one round trip per request.
- **R9** single-statement fast path for scalar edits (guarded `UPDATE`, falling back to the normal path on 0 rows). Only if the in-region re-measure shows it is needed.
- Smaller items: merge the two `assertLineCodesAllowed` selects into one `UNION ALL` (−1 statement per lines save; still two selects today). Optionally raise `idleTimeoutMillis` (5000 in `src/lib/db/client.ts`) for dev only, so a pause does not pay the 1.9 s reconnect. Narrowing the cycle check to the edited card's reachable graph would change behavior (a pre-existing cycle elsewhere blocks lines saves today), so it needs a DECISIONS row.
- **Set the Clerk session-token role claim** (RUNBOOK §3): this is the cheapest remaining gain (removes 2 statements and a Clerk API call per request).
- **Re-measure in production** (Phase 7): Vercel logs `ms`, `sql`, `sqlMs` for the same routes with `SQL_TRACE=1` briefly on, p50/p95 over about 50 saves, cold and warm. Decide R7/R9 only after that.

## How to measure
- `SQL_TRACE=1|2` (`src/lib/db/trace.ts`; launch config `isfc-dev-trace`): the `request` log line carries `sql` (count), `sqlMs` and, at 2, the statements. Pool connect time is not included in `sqlMs`.
- `node --env-file=.env.local tools/rtt.mjs` prints the round-trip time. Model: `ms ≈ statements × RTT + server/transfer + connect`.
