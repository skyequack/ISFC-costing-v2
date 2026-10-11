# schema.md — database design (Neon PostgreSQL 18, plain SQL)

**The SQL is the source of truth:** `db/migrations/0001_init.sql` (applied with `npm run db:migrate`, tracked in `schema_migrations`, forward-only, checksum-verified). This file explains the model and the rules behind it. A new migration is required for any change; never edit an applied migration.

## Conventions
- **Naming:** snake_case tables and columns (`app_user` because `user` is reserved). Docs use the conceptual model names (`Recipe.deletedAt` ↔ table `recipe`, column `deleted_at`). Rows are mapped to camelCase in TypeScript by `src/lib/db/rows.ts` (`camelRow`), nowhere else.
- **IDs:** `text` UUIDs from `gen_random_uuid()::text`. Legacy ids are not kept; key legacy data on `code`. `brand.legacy_id` keeps the legacy brand id (bnc, b1…b12, bssem).
- **Numerics:** `double precision` everywhere (parity with JS doubles; never round before storing or summing). **Timestamps:** `timestamptz` (UTC); `cost_settings.price_date` is a `date`. `updated_at` is maintained by the `set_updated_at()` trigger.
- **Connections:** the running app uses the pooled URL (`DATABASE_URL`, host contains `-pooler`) through `src/lib/db/client.ts`; migrations, seeding and bulk import/restore use `DATABASE_URL_UNPOOLED`. Transaction-scoped features (`pg_advisory_xact_lock`, `SELECT … FOR UPDATE`) are safe through the pooler.
- **Branches:** `production` (live), `dev` (local work and seeding), short-lived per-run branches for tests/CI (TTL 7 d). Take a branch / note a PITR point before every production migration.

## Tables (22 + `schema_migrations`)
| Table | Purpose / key rules |
|---|---|
| `brand` | 14 rows. `legacy_id`, `code` (recipe-code prefix), `name` unique; `name_ar`, `color` (`''` allowed), `ink_color`, `locations text[]` (only SSEM has values; GM-editable, D-52: names are referenced by `menu_pax.location` / `production_entry.location`, so rename cascades in one transaction and removal of a site with rows is refused), `active`. |
| `app_user` | Lazily provisioned on first authenticated request (single-statement upsert on `clerk_user_id`). **No role column** — Clerk `publicMetadata.role` is authoritative; `last_role_seen` is diagnostics only. `active` is the app-side backstop for Clerk bans, checked on every request. |
| `user_brand_access` | (user, brand) unique. Non-GM visibility. |
| `ingredient` | 1046 rows. `code` verbatim, case-sensitive unique. **`price` NULL = PRICE MISSING (135 rows) — never 0.** `uom` CHECK in Gram/Ml/Each/Slice (extend by migration if importers learn new units). `flag` verbatim data-quality text. `version` for optimistic concurrency. |
| `item_brand_scope` | Legacy `item.brands[]`: visibility scope (no rows = Shared). **Not** a price override. |
| `unit_conversion` | One per ingredient (legacy `S.conv`): `recipe_unit`, `factor > 0`; line cost = `qty / factor` only when the stored unit equals the line unit. |
| `ingredient_price_history` | Append-only (D-26): old/new price, source (MANUAL / IMPORT / MENU_PLAN / SEED), user snapshot. |
| `recipe` | `brand_id` **required** (D-27). `code` uniqueness = partial unique index `recipe_code_lower_live` on `lower(code) WHERE deleted_at IS NULL` (soft-deleted codes are reusable; restore must re-check). `status` DRAFT/LOCKED, `locked_by` (free-text approver), `cost_at_lock jsonb` (D-26/D-29), `version`, `deleted_at/by`. `selling_price` is ex-VAT. `buffer` NULL falls back to `cost_settings.buffer`. |
| `recipe_photo`, `brand_logo` | Images (D-48/D-49): `bytea` in their own tables so list queries cannot pull blobs; CHECKs on size and dimensions (photo ≤ 1.5 MB, ≤ 4096 px; logo ≤ 512 KB, ≤ 1024 px); `sha256` for ETags. Accessed only through the `ImageStore` interface (`src/lib/images`). |
| `recipe_line` | References an item or sub-recipe **by code string, no FK** (`CODE NOT FOUND` is a legal legacy state). `UNIQUE(recipe_id, sort_order)`, index on `code`. `y > 0` (divisor; the engine treats values ≤ 0 or > 10 as 1). **`yp` NULL ≠ 0** (NULL falls back to the card buffer). `qty ≥ 0`, finite. |
| `recipe_method_step`, `recipe_history_entry` | Ordered method steps; lock/unlock history (legacy cap of 40 is not preserved). |
| `cost_settings` | Singleton (`id = 1` CHECK). Legacy names and fractions: `pkg, del, lab, ops, buffer, target, vat`, `currency`, `price_date`, `version`. Not brand scoped. |
| `audit_log` | Append-only: triggers raise on UPDATE/DELETE/TRUNCATE. Snapshots of user name and role. "Clear activity log" is implemented as an audited archive marker (D-31). |
| `menu`, `menu_row`, `menu_cell`, `menu_pax` | Editable menus (D-05), seeded from legacy `MENU_PLAN` (8 menus, 148 rows, 1001 cells). `menu.legacy_index` translates legacy `LOC|menuIndex` pax keys on restore. Meal labels are not unique. Cell `kind` ITEM → `ingredient.code` (710), RECIPE → `recipe.code` (290), NONE (1) has no code (CHECK). Absent day = no row (23 in the seed). Deactivate menus rather than delete (pax rows cascade). |
| `production_entry` | (month, day, location, client_id, recipe_code) → portions ≥ 0; `location ''` = legacy/unassigned bucket; `client_id ''` = unassigned (migration 0003, D-71; no FK, the service checks the client is active and of the card's brand). Brand scoping through `recipe.code → brand_id`. |
| `client` | (0003, D-68/D-71) `brand_id` → brand (RESTRICT), `name` unique per brand case-insensitively, `active`, `version`. A client with production rows is deactivated, not deleted. |
| `seed_run` | Seed version + checksum; a re-seed must not overwrite edited data. |
| `restore_chunk` | (migration 0002) staging for a chunked backup restore: `(session_id, seq)` → a ≤ 1.5 MB slice of the backup JSON, owner `user_id`; deleted on commit, pruned after a day. |

## Cross-table rules enforced in the application
- Ingredient and recipe codes must not collide case-insensitively (legacy `resolve()` is items-first): checked inside a serializable transaction (retry on SQLSTATE `40001`) plus a verification query.
- Recipe code rename cascades to `recipe_line.code` and `menu_cell.code` in one transaction (D-33). Renaming/deleting an ingredient referenced by a line or menu cell is blocked.
- Cycle checks run inside the recipe save transaction under `pg_advisory_xact_lock` (D-34).
- Optimistic concurrency: `UPDATE … WHERE id = $1 AND version = $2` and `version = version + 1`; 0 rows → 409.
- The application database role must not be granted UPDATE/DELETE/TRUNCATE on `audit_log` once a restricted role is introduced; migrations run under the owner role.

## Post-seed verification (must all pass; docs/TESTING.md §2)
Counts: ingredient 1046 · recipe 321 · recipe_line 7321 · unit_conversion 34 · brand 14 · menu 8 · menu_row 148 · menu_cell 1001 · null prices 135 · flagged 161 · `item_brand_scope` = sum of legacy `brands[]`. Code sets equal the JSON both ways. 0 lower-case collisions within and across ingredient/recipe. 0 unresolved line codes; 0 lines pointing at MENU recipes; 0 self-referencing recipes; all ITEM/RECIPE menu cells resolve; all `PLAN_ALIAS` targets exist; no code has surrounding whitespace. Float round-trip of BKR2-2058 (0.006667) and DRS1-4772 (0.0064). All 321 recomputed costs equal `golden/costs.json`. UPDATE/DELETE/TRUNCATE on `audit_log` raises. Soft-delete then re-create of a recipe code works; a case-variant duplicate is rejected (SQLSTATE 23505). Seeding twice changes nothing; the production load aborts if audit rows exist.

Verified on the Neon `dev` branch right after `0001_init`: 22 tables created, the three audit blocks raise, case-insensitive duplicate rejected, code reuse after soft delete works.
