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
| PUT /api/recipes/:id/photo, DELETE | recipe.edit; rejected if LOCKED | check | Added a dish photo / Removed the dish photo |
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
| POST/PATCH/DELETE /api/brands/:id | brands.edit | Added/Edited/Removed brand (logo change logged) |
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
| POST /api/audit/archive | data.admin | archive marker (DB forbids deletes) — D-31 |
| GET /api/export/backup; POST /api/import/restore?mode=… | data.admin | chunked, DIRECT_URL; audit Restored a backup |

Implementation notes: GET endpoints that feed export require `export`; all list endpoints exclude `photo`; recipes list DTO is lightweight; `cost` endpoints use the cached catalog loader; every mutating route calls `revalidateTag('catalog')`; legacy-unaudited setters (`setProd`, `setMenuPax`) remain unaudited.
