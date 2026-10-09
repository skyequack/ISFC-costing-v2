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
| PATCH /api/recipes/:id | recipe.edit; price fields need recipe.price; rejected if LOCKED | old+new brand; line codes visible; cycle check; code rename cascade | Edited card / Changed sales price / Changed a line yield |
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
| POST/PATCH/DELETE /api/brands/:id | brands.edit | Added/Edited/Removed brand; PATCH may carry `locations` (D-52: rename cascades to `menu_pax`/`production_entry` rows in one transaction, removing a site that has stored rows → 409 with the row count) → `Edited brand sites` |
| GET /api/brands/:id/logo | any (brand in scope, else 404) | – (bytes + `ETag`; 404 if none) |
| PUT /api/brands/:id/logo | brands.edit | Brand logo changed (set) |
| DELETE /api/brands/:id/logo | brands.edit | Brand logo changed (removed) |

**Image upload contract (D-49).** `PUT` body = the raw image bytes with `Content-Type` image/png|jpeg|webp (no base64, no multipart). The server ignores the declared type, sniffs magic bytes, parses width/height, enforces the caps (photo ≤ 1.5 MB / 4096 px, logo ≤ 512 KB / 1024 px), stores `{contentType,data,size,width,height,sha256}` and returns `{url, sha256, size, width, height}`. Errors: 400 not an image / unsupported type (SVG, GIF), 413 over cap, 422 locked card, 404 out of scope. DTOs expose `photoUrl`/`logoUrl` = `/api/…/photo|logo?v=<sha8>` (null when none); list endpoints never include bytes. **Add brand in one step:** the UI creates the brand (`POST /api/brands`) then uploads the logo (`PUT …/logo`); if the second call fails the brand exists without a logo and the UI says so (retry from Edit brand). Same two-step for the optional photo in the New-card dialog.
| GET /api/users; POST /api/users/invite; PATCH /api/users/:id {role, brandIds, name}; POST /api/users/:id/ban\|unban; DELETE /api/users/:id | users.manage | Invited/Updated/Suspended/Restored/Deleted user |

## Planning & production
| Method path | Permission | Notes / Audit |
|---|---|---|
| GET /api/menus; POST /api/menus; PUT /api/menus/:id; POST /api/menus/:id/deactivate | read: any (SSEM-scoped); write: menu.edit | Menu edited |
| PUT /api/menu-pax | recipe.edit | none (legacy) |
| PUT /api/production | recipe.edit | none (legacy) |
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
