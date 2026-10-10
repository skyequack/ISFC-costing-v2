# Perf plan: slow card saves

Status (2026-10-10): **R1, R2, R3, R4, R5, R6, R8 and the client save-batching are implemented** (see docs/PROGRESS.md "Live GM pass" for results and tests). **Not implemented:** R7 (user/scope cache, needs a DECISIONS row because D-35 says every request loads the user row) and R9 (single-statement fast path, only if still needed after the `fra1` deploy re-measure). R5 only takes effect once the Clerk session token carries the `role` claim (RUNBOOK §3). The text below is the original design; where it differs from the code, the code and PROGRESS.md are authoritative. Anything marked **needs DECISIONS row** diverges from a written decision and must be approved first (CLAUDE.md).
Inputs: `docs/PROGRESS.md` "Live GM pass", `docs/ARCHITECTURE.md` §Costing/§Runtime, D-26/29/33/34/35/40/42, and the code cited below.

## 0. Why it is slow (what the code actually does)

A name-only `PATCH /api/recipes/[id]` (`src/app/api/recipes/[id]/route.ts:15-23`) = `withAuth` -> `inTx` -> `saveRecipe` -> `recipeDetail`, 17 statements:

| # | Statement | Code |
|---|-----------|------|
| 1 | `SELECT ... FROM app_user` | `auth/session.ts:42` (called from `withAuth`, `with-auth.ts:50`) |
| 2 | `BEGIN` | `db/client.ts:49` |
| 3 | `SELECT id FROM brand ORDER BY id` | `db/scope.ts:22`, via `inTx` (`api.ts:8-10`) |
| 4 | head `FOR UPDATE` | `recipes.ts:41-67` |
| 5-6 | lines, method | `recipes.ts:190-195` |
| 7 | `pg_advisory_xact_lock` | `recipes.ts:246` (taken for ANY non-empty `fields`) |
| 8 | `UPDATE recipe ... version+1` | `recipes.ts:299` |
| 9 | audit dedupe `SELECT` (+ INSERT when not recent) | `recipes.ts:362-367`, `audit.ts:15` |
| 10-13 | `getRecipe`: head, lines, method, history | `db/repo/recipes.ts:62-83` |
| 14-16 | `loadCatalog`: ingredient+conv, all recipes+lines, settings | `db/catalog.ts:32-51`, called at `recipe-detail.ts:28` |
| (17) | packaging `SELECT` only if lines exist (`recipe-detail.ts:32-37`); `COMMIT` `client.ts:51` | |

Facts that drive the plan:

* Latency is round trips (ARCHITECTURE §Runtime says so). Statement 15 also moves about 5-8k rows (every ingredient, every recipe line) to rebuild a `CostContext` of which the engine reads only the card's reachable codes: `engine.ts:35` (`ctx.items.get`), `:44` (`ctx.recipes.get`), `:86`/`issues.ts:49` (`ctx.conv` by code), `issues.ts:46-47`. `buildContext` (`types.ts:121-131`) builds Maps and nothing iterates them. The cost of one card therefore depends only on the **transitive closure of its line codes**, not on the whole catalog.
* The cached catalog (`db/catalog-cache.ts:7`, `unstable_cache`, tag `catalog`) is used only by pages (`page.ts:26`, `catalog-search.ts:28`). `recipeDetail` bypasses it on purpose: inside the save transaction it must see the just-written rows (read-your-writes). `bustCatalog()` runs only after commit (`route.ts:21`). So the cached catalog is **stale for the save response** and cannot be used there as is.
* `idleTimeoutMillis: 5000` (`db/client.ts:28`): an editor who pauses over 5 s drops its connection, so the next save pays TLS+auth connect (measured about 1.9 s from the dev machine). `traceClients` (`trace.ts:29`) hooks the `connect` event, so connect time is **not** in `sqlMs`. The gap between 17 x 84 ms = 1.4 s and the measured 2.2 s is the catalog transfer/parse. Add per-statement ms to SQL_TRACE=2 to confirm (see §3).
* Costing must stay server-side: it crosses brands (sub-recipes and Shared items can be out of the caller's scope, `recipe-detail.ts:25` comment). Shipping the catalog to the browser would leak out-of-scope prices and recipes. Client-side costing is rejected.

## 1. Ranked changes

Statement counts are for name-only PATCH, cumulative, each assuming the previous ones. Sample baseline 17 (price/lines/packaging variants differ by +-2).

### R1. One load query for head+lines+method (saveRecipe) | 17 -> 15 | risk very low
Replace `lockHead` + 2 selects (`recipes.ts:182`, `:190-195`) by one statement, row lock kept:

```sql
SELECT r.id, r.code, r.name, r.category, r.type, r.brand_id, r.output, r.sub_qty, r.sub_uom, r.batch_out, r.batch_uom,
       r.selling_price, r.buffer, r.status, r.version,
       coalesce((SELECT json_agg(json_build_object('code',l.code,'qty',l.qty,'unit',l.unit,'y',l.y,'yp',l.yp) ORDER BY l.sort_order)
                   FROM recipe_line l WHERE l.recipe_id = r.id), '[]') AS lines,
       coalesce((SELECT json_agg(m.text ORDER BY m.step_number) FROM recipe_method_step m WHERE m.recipe_id = r.id), '[]') AS method
  FROM recipe r WHERE r.id = $1 AND r.deleted_at IS NULL
  FOR UPDATE OF r
```
Keep the 404/scope check (`canSeeBrand`, `recipes.ts:49`) and the LOCKED/version checks in TS in the same order (locked 422 before version 409, `:183-189`). Float equality in `sameLines` (`:159-164`) relies on the doubles round-tripping: Postgres >= 12 prints shortest round-trip `float8` in JSON, so `JSON.parse` yields the same double `pg` gets from the text protocol. This is asserted by test T1 (do not assume).

### R2. Take the graph/code advisory lock only when needed | 15 -> 14 | risk low
Today `pg_advisory_xact_lock` is taken after any non-empty `fields` (`recipes.ts:246`). Its job (D-34, D-33): serialise code allocation/uniqueness (`nextCode`, `assertCodeFree`), `assertLineCodesAllowed`, and `graphWith`. Needed iff `linesChanged || codeChanged || regenCode-path || type/brandId change`. Not needed for name, category, output, subQty/subUom, batchOut/batchUom, buffer, sellingPrice, method: none read or write anything the lock protects, and the row `FOR UPDATE` already serialises concurrent saves of the same card. Compute `needsGraphLock` right after the `change(...)` block (`:204-235`) and keep the existing order (row lock, then advisory lock, `:182` then `:246`) so no deadlock is introduced. Type and brand changes keep the lock (conservative, they feed `assertLineCodesAllowed` of other cards' saves).

### R3. Audit in one statement | 14 -> 14 (13 with R6); saves 1 on every non-deduped save | risk low
Replace the dedupe SELECT + INSERT (`recipes.ts:362-367`) with one `INSERT ... SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE user_id=$1 AND action='Edited card' AND detail LIKE $6 ESCAPE '\' AND created_at > now() - interval '10 minutes')`. Note the existing `LIKE` already uses the default `\` escape. When several audit rows are produced in one save (price + yield + rename + edited, `:336-368`) send them as one `INSERT ... SELECT FROM unnest(...) WITH ORDINALITY ORDER BY ord` so row order and ids are unchanged. The immutability triggers (`0001_init.sql:197-198`) only fire on UPDATE/DELETE/TRUNCATE, so INSERT..SELECT is fine.

### R4. recipeDetail from ONE statement, with the cost closure instead of the full catalog | 14 -> 8 | gain highest | risk medium (needs equivalence tests)
New `loadDetail(db, scope, id)` returning head (+photo sha/size, locked_*, cost_at_lock), lines, method, history, the **closure catalog**, settings, packaging codes, in one round trip. Shape:

```sql
WITH RECURSIVE
head AS (SELECT r.*, p.sha256 AS photo_sha, p.size AS photo_size FROM recipe r LEFT JOIN recipe_photo p ON p.recipe_id = r.id
          WHERE r.id = $1 AND r.deleted_at IS NULL AND r.brand_id = ANY($2::text[])),
walk(code) AS (
   SELECT l.code FROM recipe_line l JOIN head ON l.recipe_id = head.id WHERE l.code <> ''
   UNION                                   -- UNION (not ALL) so cycles terminate
   SELECT l2.code FROM walk w
     JOIN recipe r2 ON r2.code = w.code AND r2.deleted_at IS NULL
     JOIN recipe_line l2 ON l2.recipe_id = r2.id WHERE l2.code <> ''),
items AS (SELECT i.code, i.name, i.uom, i.price, i.category, c.recipe_unit, c.factor
            FROM ingredient i LEFT JOIN unit_conversion c ON c.ingredient_id = i.id WHERE i.code IN (SELECT code FROM walk)),
recs  AS (SELECT r.code, r.name, r.type, r.output, r.sub_qty, r.sub_uom, r.batch_out, r.batch_uom, r.selling_price, r.buffer,
                 (SELECT json_agg(json_build_object(...) ORDER BY l.sort_order) FROM recipe_line l WHERE l.recipe_id = r.id) AS lines
            FROM recipe r WHERE r.deleted_at IS NULL AND (r.code IN (SELECT code FROM walk) OR r.id = $1))
SELECT (SELECT row_to_json(head) FROM head) AS head, ... , (SELECT row_to_json(s) FROM cost_settings s WHERE id = 1) AS settings
```
TS then calls the **unchanged** `buildContext` (`types.ts:121`) with the closure rows and the unchanged `buildCardView` (`card-view.ts:57`), so costing code is untouched. Packaging = closure items of the card's own lines whose category normalises to `nonfood` (the regex at `recipe-detail.ts:34` moved into TS or kept in SQL, same expression). Why it is exactly equivalent: the engine only does `Map.get(code)` for codes reachable from the card's lines; `ORDER BY l.sort_order` preserves float summation order (`engine.ts` `batch` accumulates in line order); the card's own row is included for self-reference/cycle semantics (`engine.ts:25`); item-over-recipe precedence is unchanged because both maps are filled. Recursing from any live recipe (not only SUB) gives a superset, never a subset. Unknown/deleted codes behave as before (absent from both maps -> `unknown code`). `GET /api/recipes/[id]` and `edit/[id]/page.tsx:13` use the same function (10 -> 3 statements: user, scope, detail, or 2 after R5).

Why not the cached catalog here: it would be stale for the card just written (revalidate happens after commit), could be stale across instances, and lock/cost gates (D-29) must stay on fresh data. The closure query is 1 RTT anyway, so the cache would save at most one RTT at a correctness price.

### R5. Merge user lookup and brand scope into the session query | 8 -> 7 (every authenticated route) | risk low
`getSession` already knows `role` from the claim before it queries (`session.ts:66-67`). Run one statement:
```sql
SELECT u.id, u.clerk_user_id, u.email, u.name, u.active, u.last_role_seen,
       CASE WHEN $2 = 'gm' THEN array(SELECT id FROM brand ORDER BY id)
            ELSE array(SELECT brand_id FROM user_brand_access WHERE user_id = u.id ORDER BY brand_id) END AS brand_ids
  FROM app_user u WHERE u.clerk_user_id = $1
```
(only when the claim role is present; fall back to today's path otherwise), return `scope` on the `SessionResult` ok-branch, and let `withAuth` hand it to handlers so `inTx`/`withScope` (`api.ts:8-15`) skip `visibleBrandIds`. Keep `makeScope` as the only constructor (`scope.ts:16`) so the brand-scope invariant (D-35) is unchanged; `visibleBrandIds` stays for non-API callers/tests. Semantics change: scope is read a few ms before `BEGIN` instead of inside the tx. Under READ COMMITTED this is the same visibility window as today (each statement sees latest commits); the `api.ts:7` comment ("INSIDE it") becomes "at request start". Document it in ARCHITECTURE. Inactive users are still rejected on every request (D-35 intact, no cache).

### R6. Fold UPDATE recipe + audit (+ delete-lines) into data-modifying CTEs | 7 -> 6 (scalar), lines PATCH -2 | risk low-medium
`WITH u AS (UPDATE recipe ... RETURNING version, updated_at) INSERT ... ` is safe. Do **not** CTE `DELETE FROM recipe_line` together with the re-`INSERT` of the same table: `UNIQUE (recipe_id, sort_order)` (`0001_init.sql:147`) is not deferrable and CTE sub-statement order is unspecified. A DELETE of lines can share a statement with the `UPDATE recipe` (different tables). Keep `rowCount === 0 -> 409` (`recipes.ts:304`) by returning `count(*)` of `u`.

### R7. Cache the app_user row (and scope) per instance, TTL 5-10 s | 6 -> 5 (everywhere, -1 RTT per request) | **needs DECISIONS row** (D-35 says every request loads the User row and rejects inactive)
Key = clerk user id. Value = `{row, brandIds}`. TTL <= 10 s, per instance (`globalThis` Map like `__pool`, `client.ts:15`). Invalidation: (a) TTL; (b) explicit `invalidateUser(id)` in `services/users.ts` at the writes `:119-124` (role/name/brands), `:163` (suspend/unsuspend), `:183-184` (delete) so the instance that handled the admin action is immediately consistent; (c) `brands.ts` brand create/delete for GM scope. Other instances lag by <= TTL; a suspended user is also dropped by Clerk at the next token refresh, so the worst case is a few seconds of access beyond what Clerk already allows. If the user will not accept that, skip R7; R5 already removes the second lookup without any staleness.

### R8. Build the PATCH response without a re-read (scalar and method edits) | 6 -> 4 | risk medium
For edits that do not touch lines or code the loaded rows plus `RETURNING version, updated_at` fully determine the new `RecipeDetail`; the closure of the unchanged lines is already in the (R4) load statement, so `load (incl. closure+history+photo+settings)` -> `UPDATE+audit CTE` -> `COMMIT`. Overlay: `ctx.recipes.set(card.code, newCard)` before `buildCardView` to keep self-reference identical. For lines/code edits keep the R4 re-read (closure depends on the new lines; it can run in the same statement as the fresh-code check, because both depend only on request codes). Count with R5: user+scope, BEGIN, load, UPDATE+audit, COMMIT = 5; with R7 = 4.

### R9. Single-statement fast path (no BEGIN/COMMIT, no FOR UPDATE) | 5 -> 2 (1 with R7) | risk medium-high, last
Only for requests whose keys are in {name, category, output, subQty, subUom, batchOut, batchUom, buffer, sellingPrice, method} and where `can(role,'recipe.edit')` (+ `'recipe.price'` when `sellingPrice` is present) already holds in TS. One statement: guarded `UPDATE recipe SET ..., version = version+1 WHERE id=$1 AND version=$2 AND status='DRAFT' AND deleted_at IS NULL AND brand_id = ANY($scope) AND (name IS DISTINCT FROM $n OR ...)` + audit `INSERT ... WHERE NOT EXISTS` + the detail SELECTs (R4/R8) in the same statement. **Zero rows updated -> fall back to the current slow path** so every error keeps its exact status (404 vs 409 vs 422 vs no-op `{changed:false}` without a version bump, `recipes.ts:236`) and permission-error behaviour for no-op edits is identical. Method steps need DELETE+INSERT of the same table: either go through the slow path or use `ON CONFLICT (recipe_id, step_number) DO UPDATE` + trailing DELETE (two statements; method edits are not in the fast set at first). Optimistic `version` guard replaces the row lock: a concurrent writer changes `version`, so one of the two gets 0 rows and retries on the slow path (409 as today).

### R10. Narrower wins that are independent of the above
* **Merge the two `assertLineCodesAllowed` selects** (`recipes.ts:123-132`) into one `UNION ALL`: -1 on lines saves.
* **Cycle check payload** (`graphWith`, `:147-157`) already one statement; it scans all recipes each lines save. Narrowing it to "reachable from the candidate" would change behaviour (today a pre-existing cycle elsewhere blocks every lines save, `graph.ts:24`): **needs DECISIONS row**, keep as is.
* **Client coalescing** (`EditScreen.tsx:76-100`): the queue sends one PATCH per edit, serially. Merge patches queued while one is in flight (object spread, last key wins; `lines`/`method` are full arrays so last wins is correct; `version` is read at send time via `verRef`). Burst edits (typing then blur, yield and qty) cost one request, not N. No server change, covered by `tests/ui`.
* **Dev only**: raise `idleTimeoutMillis` via env in dev (default 5000 kept for Vercel where `attachDatabasePool` handles idling) so a pause does not re-pay the 1.9 s connect.
* `lockRecipes`/`import-recipes`/`planning-apply` keep the full `loadCatalog(tx)` (`recipes.ts:552`): lock gate must see all prices in one snapshot. Not touched.

### Projected statement counts

| Operation | now | R1-R3 | +R4 | +R5 | +R6 | +R7 | +R8 | +R9 |
|---|---|---|---|---|---|---|---|---|
| name-only PATCH | 17 | 14 | 8 | 7 | 6 | 5 | 4 | 2 (1 with R7) |
| lines PATCH | 23 | 20 | ~14 | 13 | ~11 | 10 | 10 | n/a (slow path) |
| GET card | 10 | 10 | 3 | 2 | 2 | 1 | | |
| POST create | 13 | | | -1 | | -1 | | |
| DELETE | 7 | | | 6 | | 5 | | |

(lines PATCH after R4-R6 is roughly: session+scope, BEGIN, load, lock, allowed-codes(1), graph, UPDATE(+DELETE lines) , INSERT lines, audit, detail, COMMIT.)

## 2. Correctness risks and tests

Offline = `npx vitest run`. DB = `tests/db/*.test.ts` against Neon dev (not run by this plan). The service signatures (`saveRecipe(tx,user,scope,id,input)`) stay, so `tests/db/services.test.ts:122-221` (409 stale version `:132`, no-op `:133`, 403 field-level `:141-143`, 422 unknown/out-of-scope codes `:160-161`, cycles `:175-177`, code collisions and rename cascade `:188-198`, locked 422 `:221`) is the regression harness for R1-R3, R6, R8, R9 unchanged. Add:

| ID | Covers | Test |
|---|---|---|
| T1 | R1 | DB: for every live card, new load query deep-equals the old 3-query load (lines incl. `y`, `yp` null vs 0, float qty like 0.1+0.2 class values; method). |
| T2 | R2 | DB: two concurrent name-only saves on **different** cards do not block each other (no wait on the advisory lock; assert via `pg_locks` in a third client); concurrent lines save + code rename still serialise (existing `:175-198` tests). Offline unit: table-driven `needsGraphLock(input, head)` over key combinations. |
| T3 | R3 | DB: audit rows for price+yield+rename+edit have same actions, details and relative order as before; dedupe within 10 min; no dedupe across users/cards; `%`/`_` in code is escaped. |
| T4 | R4 (critical) | DB: for all 321 seed cards + synthetic cases (cycle, self reference, missing price, missing conversion, unknown code, non-sub code, out-of-scope sub-recipe, soft-deleted sub-recipe, blank row, item/recipe same code) assert `buildCardView(closureCtx, rec)` is `toEqual` (and `Object.is` on numbers) to `buildCardView(fullCatalogCtx, rec)`, and `view.cost.issues` equal. Plus golden: `tests/costing-golden.test.ts` unchanged and green. Offline twin: pure-TS `closureOf(code, catalogData)` fixture test proves "engine only reads reachable codes" by costing every golden recipe from a closure-restricted `buildContext`. |
| T5 | R4 | DB: `recipeDetail` before/after refactor returns JSON-equal payloads for a card in each brand/role scope; out-of-scope id -> 404 (head CTE empty) with no other rows leaked. |
| T6 | R5 | Offline `tests/with-auth.test.ts` style: scope for gm = all brands, for others only `user_brand_access` rows, none = empty; inactive -> 403 still; claim-less role still goes through the Clerk path. DB: scope identical to `visibleBrandIds` for every seed user. `tests/routes-meta.test.ts` stays green (all handlers still wrapped). |
| T7 | R6 | DB: stale version -> 409 with `currentVersion`; `rowCount` semantics preserved; audit row rolled back with the transaction on failure. |
| T8 | R7 | Offline with fake timers: hit within TTL skips DB; after TTL refetches; `invalidateUser` on role/suspend/brand change; suspended user rejected after invalidation on the same instance. |
| T9 | R8/R9 | DB: PATCH response `toEqual` the slow-path response for scalar edits (version, `updatedAt` type, history, `photoUrl`, `view`); fast path falls back for stale version/locked/missing/foreign-brand/no-op/missing permission and returns the same status as before; concurrent same-card saves: exactly one wins, other gets 409. |
| T10 | client | `tests/ui`: coalescing sends one PATCH for two quick edits, uses the latest version, still toasts and `router.refresh()` on 409/422, lines edits in the same tick still compose (`linesRef`, `EditScreen.tsx:152-160`). |

Additional invariants to assert in review: no module other than `makeScope` builds a `BrandScope`; every route still uses `withAuth` (routes-meta); no new rounding; `catalog` tag still busted after commit (`bustCatalog`) for every mutation.

## 3. Measurement

1. Baseline and after each step on the same card: `isfc-dev-trace` launch config (`.claude/launch.json`: `SQL_TRACE=2`), then PATCH name, PATCH qty line, GET card, create, delete. The `request` log line carries `sql` (count), `sqlMs`, `q[]` (`with-auth.ts:28-35`). Record `ms - sqlMs` too: that is JSON/costing/Clerk time.
2. Extend the tracer (small change in `trace.ts:36-45`): push `${elapsedMs}ms ${text}` per statement, and count rows/bytes returned, so catalog transfer cost is visible (expect statement "SELECT r.id AS rid" to be the slowest by far). Also time `pool.connect()` separately (cold connect is invisible today).
3. `node --env-file=.env.local tools/rtt.mjs` gives RTT (84 ms). Model: `ms ~= n * RTT + sum(server+transfer) + connect`. Verify each step by predicting `n`, then checking `sql` equals the table above.
4. Compare cold (wait > 5 s) vs warm saves to size the `idleTimeoutMillis` effect.
5. Local pure-CPU cost of `buildContext`+costing over the closure vs the full catalog: a one-off script around `loadCatalogData` (not committed).
6. After deploy (Phase 7): Vercel function logs `ms`, `sql`, `sqlMs` for the same routes with `SQL_TRACE=1` temporarily on; p50/p95 over 50 saves; one cold and one warm instance.

## 4. Shipping order (gain / risk), each independently shippable

1. **R5** merge user+scope (all routes, -1; no staleness; no data semantics). Update ARCHITECTURE note.
2. **R1** single load, **R2** conditional lock, **R3** audit statement, **R10** `UNION ALL` of allowed-codes. Pure server refactors behind unchanged signatures; existing DB tests are the net.
3. **R4** `loadDetail` with closure (largest win, adds T4/T5). Ship alone and soak. Also wire `edit/[id]/page.tsx` and GET.
4. **Client coalescing** (R10) - independent of everything.
5. **R6** CTE folds, then **R8** no re-read.
6. **R7** user cache - only after DECISIONS row approval (D-35 amendment, TTL value).
7. **R9** fast path - only if R1-R8 are not enough after the deployment re-measure.

Not recommended: stored-procedure for the whole save (moves business rules into SQL and duplicates TS validation); cached catalog inside saves (stale); client-side costing (cross-brand leak).

## 5. Expected effect when deployed (Vercel fra1 next to Neon eu-central-1)

* RTT there is about 1-3 ms (same region/AZ class) instead of 84 ms, so the 17-statement save costs roughly 17 x 2 = 35 ms of waiting. What remains large is **per-statement work and bytes**: the full-catalog load (about 8k rows to JSON-parse and `buildContext`) is probably 30-80 ms of CPU+transfer and becomes the dominant term, so **R4 is the single most valuable change in production**, more than the statement-count items.
* Expected after R1-R5: about 7 statements, about 15-30 ms of DB time per name-only save; after R8: about 4 statements. R7/R9 save only a few ms in-region; their benefit is mainly for the dev machine (where each removed RTT is 84 ms: 2.5 s -> about 0.6 s at 7 statements, about 0.35 s at 4, about 0.17 s at R9).
* Cold-start costs do not go away: Neon compute wake after scale-to-zero (seconds) and a fresh pooled connect after `idleTimeoutMillis` (a few RTTs, tens of ms in-region). Keep `attachDatabasePool`; consider a longer idle timeout once Fluid instance lifetime is measured.
* Re-measure after Phase 7 as PROGRESS.md says; do not decide R7/R9 before that number exists.
