# API — endpoints, permissions, brand checks, audit actions
Conventions: all handlers wrapped in `withAuth`; JSON; Zod-validated; errors per ARCHITECTURE §2; `version` required on mutating PATCH/PUT of versioned entities; "brand" = checked via `visibleBrandIds`; audit written in the same transaction (action strings from docs/legacy/05 §5 + new ones).

## Session
| Method path | Permission | Notes |
|---|---|---|
| GET /api/me | session | user, role, permission list, brand ids, `active` |
| GET /api/health | public | 200 + DB ping, no internals |

## Recipes
| Method path | Permission | Brand | Audit |
|---|---|---|---|
| GET /api/recipes | any (scoped) | filter | – |
| POST /api/recipes | recipe.create | brand access (brand required) | Created card |
| GET /api/recipes/:id | any | check (404 if out of scope) | – |
| PATCH /api/recipes/:id (`lines[]` may carry `yThaw`, `yCut`, `yCook`: fractions in (0,10], null = not set; while any is set the server writes `y` = their product, product outside (0,10] = 400; D-85) | recipe.edit; price fields need recipe.price; rejected if LOCKED | old+new brand; line codes visible; cycle check; code rename cascade | Edited card / Changed sales price / Changed a line yield |
| DELETE /api/recipes/:id | recipe.delete (+recipe.unlock if locked) | check | Deleted card (soft) |
| POST /api/recipes/:id/restore | recipe.delete | check, code collision re-check | Restored card |
| POST /api/recipes/:id/duplicate | recipe.create | check | Duplicated card |
| POST /api/recipes/:id/lock | recipe.lock | check | Locked card (body: approvedBy, optional overrideReason GM only; refused 422 if null-price/missing-conv lines) |
| POST /api/recipes/:id/unlock | recipe.unlock | check | Unlocked card |
| GET /api/recipes/:id/photo | any | check (404 if out of scope) | – (bytes + `ETag`, `Cache-Control: private, immutable`, `nosniff`; 404 if none) |
| PUT /api/recipes/:id/photo | recipe.edit; rejected 422 if LOCKED | check | Added a dish photo (code · w×h · KB) |
| DELETE /api/recipes/:id/photo | recipe.edit; rejected 422 if LOCKED | check | Removed the dish photo |
| GET /api/recipes/:id/cost | any | check | – (returns full `_cost` result + `complete`/`issues[]`) |
| POST /api/recipes/bulk {action: lock\|unlock\|delete} | per-action perm | all ids checked, all-or-nothing | one entry: Locked cards / Unlocked cards / Deleted cards |
| GET /api/recipes/export (CSV/XLSX data) | export | scoped | – |
| POST /api/recipes/import?mode=dry-run\|commit | recipe.create (+edit for updates) | per row | Uploaded recipe cards |

## Ingredients & conversions
| Method path | Permission | Audit |
|---|---|---|
| GET /api/ingredients | any (scope filter via ItemBrandScope; Shared visible to all) | – |
| POST /api/ingredients | items.edit | Added ingredient |
| PATCH /api/ingredients/:id | items.edit (price changes also write IngredientPriceHistory) | Changed purchase price / Edited ingredient |
| DELETE /api/ingredients/:id | items.edit; blocked if referenced | Deleted ingredient |
| POST /api/ingredients/import?mode=… | items.edit | Uploaded price list |
| GET /api/conversions; PUT/DELETE /api/conversions/:ingredientId | conv.edit | Set/Removed unit conversion |
| GET /api/ingredients/:id/price-history | items.edit or audit.view | – |

## Settings, brands, users
| Method path | Permission | Audit |
|---|---|---|
| GET /api/settings | any | – |
| PATCH /api/settings | settings.edit (version check) | Settings changed (old→new, cards affected) |
| GET /api/brands | any (scoped) | – |
| POST/PATCH/DELETE /api/brands/:id | brands.edit | Added/Edited/Removed brand; PATCH may carry `locations` (D-52: rename cascades to `menu_pax`/`production_entry` rows in one transaction, removing a site that has stored rows → 409 with the row count; a site that has stock counts or receipts can be neither renamed nor removed until slice 2e, D-76) → `Edited brand sites` |
| POST /api/brands/:id/clients | clients.edit | Added client (D-71; name unique per brand, case-insensitive → 409) |
| PATCH /api/clients/:id | clients.edit | Edited client (`name` and/or `active`, with the `version` read; stale → 409) |
| DELETE /api/clients/:id | clients.edit | Removed client (409 while production rows reference it: deactivate instead) |
| GET /api/brands/:id/logo | any (brand in scope, else 404) | – (bytes + `ETag`; 404 if none) |
| PUT /api/brands/:id/logo | brands.edit | Brand logo changed (set) |
| DELETE /api/brands/:id/logo | brands.edit | Brand logo changed (removed) |

**Rate limits (D-87, D-88).** The routes listed in `src/lib/rate-limit/budgets.ts` (paged backup export, `GET /api/export/[kind]`, restore chunk, restore dry-run/commit, the three imports, photo and logo PUT/DELETE, invites and user changes, brand add/edit/delete, activity-log archive) count each request per user and class; over budget answers `429 {error:{code:"rate_limited",message}}` with `Retry-After` (whole seconds, at least 1) and no counts in the body. The check runs after authentication and the permission check, so 401/403 are never counted or replaced, and before the handler, so a 429 never follows a side effect and the same request can simply be sent again. If the counter store is down, restore, restore chunks and user administration answer `500 internal`; every other class lets the request through. Reads, saves, bulk and search are not limited.

**Image upload contract (D-49).** `PUT` body = the raw image bytes with `Content-Type` image/png|jpeg|webp (no base64, no multipart). The server ignores the declared type, sniffs magic bytes, parses width/height, enforces the caps (photo ≤ 1.5 MB / 4096 px, logo ≤ 512 KB / 1024 px), stores `{contentType,data,size,width,height,sha256}` and returns `{url, sha256, size, width, height}`. Errors: 400 not an image / unsupported type (SVG, GIF), 413 over cap, 422 locked card, 404 out of scope. DTOs expose `photoUrl`/`logoUrl` = `/api/…/photo|logo?v=<sha8>` (null when none); list endpoints never include bytes. **Add brand in one step:** the UI creates the brand (`POST /api/brands`) then uploads the logo (`PUT …/logo`); if the second call fails the brand exists without a logo and the UI says so (retry from Edit brand). Same two-step for the optional photo in the New-card dialog.
| GET /api/users; POST /api/users/invite; PATCH /api/users/:id {role, brandIds, name}; POST /api/users/:id/ban\|unban; DELETE /api/users/:id | users.manage | Invited/Updated/Suspended/Restored/Deleted user |
| POST /api/users/invite {email, role, brandIds?}; PATCH /api/users/invites/:id {role?, brandIds?} (returns the new invitation id when the role changes); DELETE /api/users/invites/:id | users.manage | Invited user / Updated invite / Revoked invite (D-78..D-80). `:id` is the Clerk invitation id, accepted only if it is in a fresh pending list (else 404) |

## Stock (D-72, D-73)
| Endpoint | Permission | Audit |
|---|---|---|
| PUT /api/stock | stock.edit (gm, cc, fin, chef, cook) | Stock counts saved / Receipts saved (site, date, counts only) |

Body `{site, date: YYYY-MM-DD, kind: 'count'|'receipt', cells: [{code, qty: number >= 0 | null}]}` (1-1500 cells, no code twice). The site must be one of the caller's sites (union of `brand.locations` of their brands, else 404); every code an ingredient in their scope (else 422, nothing written); a date later than tomorrow UTC is 400. `qty` null clears; for counts 0 is stored (counted empty); for receipts 0 or null clears the grid row (`ref ''`), uploaded deliveries are never touched. Returns `{saved, cleared}`. Reads go through the `/stock` page (any signed-in role, so the Viewer sees it read-only).

| Endpoint | Permission | Audit |
|---|---|---|
| POST /api/stock/import?mode=dry-run\|commit | stock.edit | Uploaded stock counts / Uploaded receipts (file, hash prefix, counts, sites, dates) |

Body `{kind, rows: [{site, date, code, qty, line}], file, hash?}` (1-5000 rows, 2 MB, the whole file in one call). `dry-run` writes nothing and returns `{counts: {add, update, same, blocked}, blocked[], sample[], sites, dates, hash, alreadyImported}`. `commit` needs that `hash` (409 when the content changed), refuses a file with any blocked row (422) and, for receipts, a content already loaded (409). Counts are upserted (only changed rows written); receipts are inserted with `ref = 'file:<hash16>'`. `?mode=undo` with `{hash}` (the dry-run's hash) deletes that upload's deliveries at the caller's sites (404 when none are left), never the grid's own rows: audit `Undid a receipts upload`.

## Planning & production
| Method path | Permission | Notes / Audit |
|---|---|---|
| GET /api/menus; POST /api/menus; PUT /api/menus/:id; POST /api/menus/:id/deactivate | read: any (SSEM-scoped); write: menu.edit | Menu edited |
| PUT /api/menu-pax | recipe.edit | none (legacy) |
| PUT /api/production | recipe.edit | none (legacy). Body `{month, day, location, recipeCode, portions, clientId?}`; `clientId` `''` or omitted = unassigned (D-71). A client must exist (404), be active and belong to the card's brand (422). `portions` 0 deletes only that client's row. An inactive client takes no new row but its existing rows can still be changed or cleared. |
| POST /api/production/apply-menu-day | recipe.edit | Turned the menus into production |
| POST /api/menu-price | items.edit | Priced a menu item from the menu plan (writes Ingredient.price + history) |
| GET /api/production/{prep,requisition,day,month} | any (brand-scoped) | – |
| POST /api/production/prep-sent | export | Sent a requisition to the store |

## Audit & data admin
| Method path | Permission | Notes |
|---|---|---|
| GET /api/audit | audit.view | search, paging; CSV export requires export |
| POST /api/audit/archive | data.admin | writes `Cleared activity log`; GET /api/audit hides entries older than the latest marker unless `?archived=1` (D-31) — nothing is deleted |
| GET /api/export/backup; POST /api/import/restore?mode=… | data.admin | chunked, DATABASE_URL_UNPOOLED; audit Restored a backup |

Implementation notes: GET endpoints that feed export require `export`; all list endpoints exclude `photo`; recipes list DTO is lightweight; `cost` endpoints use the cached catalog loader; every mutating route calls `revalidateTag('catalog')`; legacy-unaudited setters (`setProd`, `setMenuPax`) remain unaudited.

**Cross-cutting (resolved decisions):** every export endpoint (recipes, ingredients, requisition, production, plan, audit CSV) writes an audit entry `Exported data` with kind and row count (D-44). Price-list import dry-run returns, per item, old price, new price and `variancePct`; items beyond ±20% (`PRICE_VARIANCE_THRESHOLD`) are marked "PRICE CHECK" in the dry-run and, when the import is confirmed, the flag is appended to `ingredient.flag` (existing flags kept, joined with " | ") (D-43).

## As built (2026-10-09) — differences from the plan above
The tables above are the original plan; this section is what exists in `src/app/api/**`. Everything is `withAuth` (meta-test) and the permission matrix is tested in `tests/authz-matrix.test.ts`.

- **Recipes.** `GET /api/recipes/:id` returns `{recipe, view, settings, packaging}` where `view` = the legacy `cost()` result + `complete`/`issues[]` and one costed entry per line (costing crosses brands, so it is computed on the server); there is no separate `/cost` route. `PATCH` takes any subset of the fields plus `version`, `lines`, `method`, and `regenCode`; a locked card refuses every edit path (422). Added: `POST /api/recipes/references` (which other cards still use the codes about to be deleted), `POST /api/recipes/bulk` (`lock | unlock | delete`, all-or-nothing), `POST /api/recipes/import?mode=dry-run|commit` (≤ 100 cards per part, `hash` from the dry-run).
- **Ingredients / conversions.** `GET/POST /api/ingredients`, `PATCH/DELETE /api/ingredients/:id`, `POST /api/ingredients/import?mode=…` (≤ 500 rows per part). Conversions are returned inside the ingredient DTO; `PUT/DELETE /api/conversions/:ingredientId`. A price-history **read** endpoint is not built (rows are written for every change; nothing displays them yet).
- **Catalog search** `GET /api/catalog/search?brandId&q&limit` (ingredient picker; 30 autocomplete / 60 browse / 0 = all).
- **Workspace** `POST /api/workspace {brandId}` sets the active-brand cookie after a scope check.
- **Settings / brands / users / audit / menus** as planned. `GET /api/audit` also serves `?format=csv` (needs `export`, audited). `POST /api/audit/archive` writes the marker. Menus: `GET/POST /api/menus`, `PUT /api/menus/:id`, `POST /api/menus/:id/active`; `PUT /api/menu-pax`; `PUT /api/production`; `POST /api/production/apply-menu-day` (`location` may be `*` = all sites, D-20); `POST /api/production/prep-sent` (`export`); `POST /api/menu-price`. The Production / Preparation / Requisition / Monthly **read models are not routes**: the pages compute them on the server (`src/lib/screens/*`).
- **Exports** `GET /api/export/:kind` for `recipes | recipe-lines | ingredients | price-template | requisition | production | prep | plan | recipes-data | dash | stock-counts-template | stock-receipts-template` (CSV; `recipes-data` returns `{filename, rows}` JSON for the browser to turn into Excel). All need `export`, are brand-scoped and write one `Exported data` audit row (kind + row count); a failed export writes none. `stock-counts-template` and `stock-receipts-template` (D-86) also need `stock.edit` (403 otherwise) and take `loc` (one of the caller's sites, else 404) and `date` (YYYY-MM-DD, else 400): the Stock upload sheet, one row per ingredient in scope, Quantity empty. `dash` (D-65/D-67) takes `brand`, `loc`, `client` (`*`, `none` = unassigned, or a client id; D-82), `from`, `to` (YYYY-MM-DD, from <= to, max 366 days; empty = all): bad date/range 400, brand or site outside the caller's scope 404; it is built by the same loader as the Dashboard page (`src/lib/services/dash.ts`), so the file equals the screen.
- **Backup** `GET /api/export/backup?part=core|photos|logos|counts|receipts&offset=&from=` (`data.admin`; images in ≤ 3 MB base64 chunks; `counts`/`receipts` are pages of 20000 stock rows dated from `from`, the core's `stockFrom` = 13 months back, D-83). **Restore** `POST /api/import/restore/chunk {session, seq, data}` (≤ 1.5 MB slices), then `POST /api/import/restore?mode=dry-run|commit {session, total, file}` (direct connection, `maxDuration` 300).
- Error codes: 400 validation, 401, 403 permission/pending/inactive, 404 missing or out of scope, 409 version/code/cycle/last-GM, 413, 422 business rule (locked, lock gate, blocked import card).
