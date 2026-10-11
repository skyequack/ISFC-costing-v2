import { z } from 'zod';
import type { PlanMenu } from '@/domain/menu-plans';
import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { appendAudit } from '../db/repo/audit';
import { assertClientForCard } from './clients';
import { canSeeBrand, type BrandScope } from '../db/scope';
import { ApiError } from '../errors';
import { can } from '../permissions';

export const monthStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM');
export const dayStr = z.string().regex(/^(0[1-9]|[12]\d|3[01])$/, 'day must be 01-31');
export const siteStr = z
  .string()
  .trim()
  .max(40)
  .refine((s) => !s.includes('|'), 'a site name cannot contain |');

/** Legacy menusVisible() (D-06): the menu plans belong to the SSEM project; the caller must have SSEM in scope. */
export async function ssemBrandId(db: Queryable): Promise<string | null> {
  const { rows } = await db.query(`SELECT id FROM brand WHERE legacy_id = 'bssem'`);
  return (rows[0]?.id as string | undefined) ?? null;
}
export async function menusVisible(db: Queryable, scope: BrandScope): Promise<boolean> {
  const id = await ssemBrandId(db);
  return id !== null && canSeeBrand(scope, id);
}
async function requireMenus(db: Queryable, scope: BrandScope): Promise<void> {
  if (!(await menusVisible(db, scope))) throw new ApiError('not_found', 'Not found');
}

export interface MenuRecord extends PlanMenu {
  sortOrder: number;
  active: boolean;
  version: number;
}

/** All menus with rows and cells (one query). Caller must have checked menusVisible(). */
export async function loadMenus(db: Queryable, includeInactive = false): Promise<MenuRecord[]> {
  const { rows } = await db.query(
    `SELECT m.id, m.name, m.sort_order, m.days, m.active, m.version,
            r.id AS rid, r.sort_order AS rs, r.meal, c.day, c.kind, c.code, c.label
       FROM menu m LEFT JOIN menu_row r ON r.menu_id = m.id LEFT JOIN menu_cell c ON c.row_id = r.id
      WHERE ($1 OR m.active) ORDER BY m.sort_order, m.id, r.sort_order, c.day`,
    [includeInactive],
  );
  const menus = new Map<string, MenuRecord>();
  const rowsById = new Map<string, MenuRecord['rows'][number]>();
  for (const r of rows) {
    let m = menus.get(r.id);
    if (!m) {
      m = {
        id: r.id,
        name: r.name,
        sortOrder: r.sort_order,
        days: r.days,
        active: r.active,
        version: r.version,
        rows: [],
      };
      menus.set(r.id, m);
    }
    if (r.rid) {
      let row = rowsById.get(r.rid);
      if (!row) {
        row = { meal: r.meal, cells: {} };
        rowsById.set(r.rid, row);
        m.rows.push(row);
      }
      if (r.day) row.cells[r.day] = { label: r.label, kind: r.kind, code: r.code };
    }
  }
  return [...menus.values()];
}

export async function listMenusFor(db: Queryable, scope: BrandScope, includeInactive = false): Promise<MenuRecord[]> {
  await requireMenus(db, scope);
  return loadMenus(db, includeInactive);
}

const cellIn = z.object({
  label: z.string().trim().max(300),
  kind: z.enum(['ITEM', 'RECIPE', 'NONE']),
  code: z.string().trim().max(60).nullable(),
});
export const menuSaveIn = z.object({
  version: z.number().int().min(0),
  name: z.string().trim().min(1).max(120),
  days: z.array(z.string().trim().min(1).max(20)).min(1).max(7),
  rows: z
    .array(z.object({ meal: z.string().trim().min(1).max(60), cells: z.record(z.string(), cellIn.nullable()) }))
    .max(80),
});
export type MenuSaveIn = z.output<typeof menuSaveIn>;

function needMenuEdit(user: SessionUser): void {
  if (!can(user.role, 'menu.edit')) throw new ApiError('forbidden', 'Your role cannot edit menu plans');
}

async function writeMenuBody(tx: Queryable, menuId: string, input: MenuSaveIn): Promise<void> {
  // every ITEM / RECIPE cell must point at something that exists
  const items = new Set<string>();
  const recipes = new Set<string>();
  for (const row of input.rows)
    for (const [day, cell] of Object.entries(row.cells)) {
      if (!cell) continue;
      if (!input.days.includes(day)) throw new ApiError('bad_request', `Cell for unknown day ${day}`);
      if ((cell.kind === 'NONE') !== (cell.code === null || cell.code === ''))
        throw new ApiError('bad_request', 'Cells without a code must be of kind NONE');
      if (cell.kind === 'ITEM') items.add(cell.code!);
      if (cell.kind === 'RECIPE') recipes.add(cell.code!);
    }
  if (items.size) {
    const r = await tx.query('SELECT code FROM ingredient WHERE code = ANY($1::text[])', [[...items]]);
    const have = new Set(r.rows.map((x) => x.code));
    const bad = [...items].filter((c) => !have.has(c));
    if (bad.length) throw new ApiError('unprocessable', `Unknown ingredient code: ${bad.slice(0, 5).join(', ')}`);
  }
  if (recipes.size) {
    const r = await tx.query('SELECT code FROM recipe WHERE code = ANY($1::text[]) AND deleted_at IS NULL', [
      [...recipes],
    ]);
    const have = new Set(r.rows.map((x) => x.code));
    const bad = [...recipes].filter((c) => !have.has(c));
    if (bad.length) throw new ApiError('unprocessable', `Unknown recipe code: ${bad.slice(0, 5).join(', ')}`);
  }
  await tx.query('DELETE FROM menu_row WHERE menu_id = $1', [menuId]); // cells cascade
  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i]!;
    const { rows } = await tx.query('INSERT INTO menu_row (menu_id, sort_order, meal) VALUES ($1,$2,$3) RETURNING id', [
      menuId,
      i,
      row.meal,
    ]);
    const rid = rows[0]!.id as string;
    const cells = Object.entries(row.cells).filter(([, c]) => c !== null) as [string, z.output<typeof cellIn>][];
    if (cells.length)
      await tx.query(
        `INSERT INTO menu_cell (row_id, day, kind, code, label)
         SELECT $1, d, k::menu_cell_kind, nullif(c, ''), l FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS t(d,k,c,l)`,
        [
          rid,
          cells.map(([d]) => d),
          cells.map(([, c]) => c.kind),
          cells.map(([, c]) => c.code ?? ''),
          cells.map(([, c]) => c.label),
        ],
      );
  }
}

export async function createMenu(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  name: string,
  days: string[],
): Promise<string> {
  needMenuEdit(user);
  await requireMenus(tx, scope);
  const dup = await tx.query('SELECT 1 FROM menu WHERE lower(name) = lower($1)', [name]);
  if (dup.rows[0]) throw new ApiError('conflict', 'A menu with that name already exists');
  const n = Number((await tx.query('SELECT coalesce(max(sort_order), -1) + 1 AS n FROM menu')).rows[0]!.n);
  const { rows } = await tx.query('INSERT INTO menu (name, sort_order, days) VALUES ($1,$2,$3) RETURNING id', [
    name,
    n,
    days,
  ]);
  await appendAudit(tx, user, 'Menu edited', `${name}: created`);
  return rows[0]!.id as string;
}

export async function saveMenu(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  id: string,
  input: MenuSaveIn,
): Promise<void> {
  needMenuEdit(user);
  await requireMenus(tx, scope);
  const cur = (await tx.query('SELECT name, version FROM menu WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!cur) throw new ApiError('not_found', 'Not found');
  if (cur.version !== input.version)
    throw new ApiError('conflict', 'This menu was changed by someone else - reload it');
  if (input.name !== cur.name) {
    const dup = await tx.query('SELECT 1 FROM menu WHERE lower(name) = lower($1) AND id <> $2', [input.name, id]);
    if (dup.rows[0]) throw new ApiError('conflict', 'A menu with that name already exists');
  }
  await writeMenuBody(tx, id, input);
  await tx.query('UPDATE menu SET name = $2, days = $3, version = version + 1 WHERE id = $1', [
    id,
    input.name,
    input.days,
  ]);
  await appendAudit(tx, user, 'Menu edited', `${input.name}: ${input.rows.length} rows`);
}

export async function setMenuActive(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  id: string,
  active: boolean,
): Promise<void> {
  needMenuEdit(user);
  await requireMenus(tx, scope);
  const r = await tx.query('UPDATE menu SET active = $2, version = version + 1 WHERE id = $1 RETURNING name', [
    id,
    active,
  ]);
  if (!r.rows[0]) throw new ApiError('not_found', 'Not found');
  await appendAudit(tx, user, 'Menu edited', `${r.rows[0].name}: ${active ? 'reactivated' : 'deactivated'}`);
}

// ---------------------------------------------------------------- headcounts and production figures

async function siteAllowed(tx: Queryable, brandId: string, location: string): Promise<void> {
  if (location === '') return;
  const b = (await tx.query('SELECT locations FROM brand WHERE id = $1', [brandId])).rows[0];
  if (!b || !(b.locations as string[]).includes(location))
    throw new ApiError('bad_request', `Unknown site ${location}`);
}

export const paxIn = z.object({
  month: monthStr,
  day: dayStr,
  location: siteStr.default(''),
  menuId: z.string().min(1).max(64),
  people: z.number().finite().min(0).max(1e7),
});

/** Legacy setMenuPax (2221): rounded, >= 0, 0 deletes. Needs recipe.edit (D-32). */
export async function setMenuPax(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  input: z.output<typeof paxIn>,
): Promise<void> {
  if (!can(user.role, 'recipe.edit')) throw new ApiError('forbidden', 'Your role cannot do that');
  await requireMenus(tx, scope);
  const ssem = (await ssemBrandId(tx))!;
  await siteAllowed(tx, ssem, input.location);
  const m = await tx.query('SELECT 1 FROM menu WHERE id = $1', [input.menuId]);
  if (!m.rows[0]) throw new ApiError('not_found', 'Not found');
  const q = Math.max(0, Math.round(input.people));
  if (q)
    await tx.query(
      `INSERT INTO menu_pax (month, day, location, menu_id, people) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (month, day, location, menu_id) DO UPDATE SET people = EXCLUDED.people`,
      [input.month, input.day, input.location, input.menuId, q],
    );
  else
    await tx.query('DELETE FROM menu_pax WHERE month = $1 AND day = $2 AND location = $3 AND menu_id = $4', [
      input.month,
      input.day,
      input.location,
      input.menuId,
    ]);
}

export const productionIn = z.object({
  month: monthStr,
  day: dayStr,
  location: siteStr.default(''),
  recipeCode: z.string().trim().min(1).max(60),
  /** D-71: '' = unassigned. Part of the row's key, so two clients never overwrite each other. */
  clientId: z.string().max(64).default(''),
  portions: z.number().finite().min(0).max(1e7),
});

async function cardForProduction(tx: Queryable, scope: BrandScope, code: string): Promise<{ brandId: string }> {
  const r = (await tx.query(`SELECT brand_id, type FROM recipe WHERE code = $1 AND deleted_at IS NULL`, [code]))
    .rows[0];
  if (!r || !canSeeBrand(scope, r.brand_id)) throw new ApiError('not_found', 'Not found');
  if (r.type === 'SUB') throw new ApiError('unprocessable', 'Sub-recipes are not produced directly');
  return { brandId: r.brand_id as string };
}

/** Legacy setProd (2077): rounded, >= 0, 0 deletes. Needs recipe.edit (D-32); the card must be in the caller's brands. */
export async function setProduction(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  input: Omit<z.output<typeof productionIn>, 'clientId'> & { clientId?: string },
): Promise<void> {
  const clientId = input.clientId ?? '';
  if (!can(user.role, 'recipe.edit')) throw new ApiError('forbidden', 'Your role cannot do that');
  const { brandId } = await cardForProduction(tx, scope, input.recipeCode);
  await siteAllowed(tx, brandId, input.location);
  await assertClientForCard(tx, scope, clientId, brandId, {
    month: input.month,
    day: input.day,
    location: input.location,
    recipeCode: input.recipeCode,
  });
  const q = Math.max(0, Math.round(input.portions));
  if (q)
    await tx.query(
      `INSERT INTO production_entry (month, day, location, client_id, recipe_code, portions) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (month, day, location, client_id, recipe_code) DO UPDATE SET portions = EXCLUDED.portions`,
      [input.month, input.day, input.location, clientId, input.recipeCode, q],
    );
  else
    await tx.query(
      'DELETE FROM production_entry WHERE month = $1 AND day = $2 AND location = $3 AND client_id = $4 AND recipe_code = $5',
      [input.month, input.day, input.location, clientId, input.recipeCode],
    );
}

export interface ProdEntryRow {
  day: string;
  location: string;
  /** '' = unassigned (D-71) */
  clientId: string;
  code: string;
  portions: number;
}

/** Production figures of a month for cards in the caller's brands (brand scope through recipe.code, D-07). */
export async function loadProduction(db: Queryable, scope: BrandScope, month: string): Promise<ProdEntryRow[]> {
  const { rows } = await db.query(
    `SELECT p.day, p.location, p.client_id, p.recipe_code AS code, p.portions
       FROM production_entry p JOIN recipe r ON r.code = p.recipe_code AND r.deleted_at IS NULL
      WHERE p.month = $1 AND r.brand_id = ANY($2::text[]) ORDER BY p.day, p.recipe_code`,
    [month, [...scope.brandIds]],
  );
  return rows.map((r) => ({
    day: r.day as string,
    location: r.location as string,
    clientId: r.client_id as string,
    code: r.code as string,
    portions: r.portions as number,
  }));
}

export interface ProdTotalRow {
  code: string;
  portions: number;
}

/** ISO date text of a production row; a day past the end of the month (production accepts 31 in any month) counts as the last day. */
const PROD_DATE = `CASE WHEN p.month ~ '^\\d{4}-(0[1-9]|1[0-2])$' AND p.day ~ '^(0[1-9]|[12]\\d|3[01])$'
  THEN p.month || '-' || to_char(LEAST(p.day::int, EXTRACT(DAY FROM ((p.month || '-01')::date + interval '1 month' - interval '1 day'))::int), 'FM00')
  ELSE p.month || '-' || p.day END`;

/**
 * Portions per card over a day-level inclusive range (D-65), for cards of the caller's scope (brand scope through
 * recipe.code, D-07), optionally narrowed to one brand the caller can see. Dates are compared as ISO text. A null
 * bound is open; loc null = every site.
 */
export async function loadProductionRange(
  db: Queryable,
  scope: BrandScope,
  brandId: string | null,
  from: string | null,
  to: string | null,
  loc: string | null,
): Promise<ProdTotalRow[]> {
  const ids = brandId === null ? scope.brandIds : scope.brandIds.filter((b) => b === brandId);
  const { rows } = await db.query(
    `SELECT p.recipe_code AS code, SUM(p.portions)::double precision AS portions
       FROM production_entry p JOIN recipe r ON r.code = p.recipe_code AND r.deleted_at IS NULL
      WHERE r.brand_id = ANY($1::text[])
        AND ($2::text IS NULL OR ${PROD_DATE} >= $2)
        AND ($3::text IS NULL OR ${PROD_DATE} <= $3)
        AND ($4::text IS NULL OR p.location = $4)
      GROUP BY p.recipe_code`,
    [[...ids], from, to, loc],
  );
  return rows as unknown as ProdTotalRow[];
}

export async function loadPax(
  db: Queryable,
  month: string,
): Promise<{ day: string; location: string; menuId: string; people: number }[]> {
  const { rows } = await db.query('SELECT day, location, menu_id, people FROM menu_pax WHERE month = $1 ORDER BY day', [
    month,
  ]);
  return rows.map((r) => ({ day: r.day, location: r.location, menuId: r.menu_id, people: r.people }));
}

export const applyDayIn = z.object({
  month: monthStr,
  day: dayStr,
  /** a site name, '' (unassigned) or '*' (every site added together, D-20) */
  location: siteStr.default(''),
});

export async function priceMenuItem(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  code: string,
  price: number,
  addHistory: (itemId: string, was: number | null, now: number) => Promise<void>,
): Promise<{ name: string }> {
  if (!can(user.role, 'items.edit')) throw new ApiError('forbidden', 'Your role cannot do that');
  await requireMenus(tx, scope);
  const it = (
    await tx.query('SELECT id, code, name, price, flag, version FROM ingredient WHERE code = $1 FOR UPDATE', [code])
  ).rows[0];
  if (!it) throw new ApiError('not_found', 'Not found');
  if (!(price >= 0) || !isFinite(price)) throw new ApiError('bad_request', 'Enter a price of 0 or more');
  const flag = /PRICE MISSING/i.test(it.flag as string) ? '' : (it.flag as string);
  await tx.query(
    'UPDATE ingredient SET price = $2, price_updated_at = now(), flag = $3, version = version + 1 WHERE id = $1',
    [it.id, price, flag],
  );
  await addHistory(it.id as string, it.price as number | null, price);
  const f = (v: number | null) => (v == null ? 'no price' : v.toFixed(4));
  await appendAudit(
    tx,
    user,
    'Priced a menu item from the menu plan',
    `${it.code} ${it.name}: ${f(it.price as number | null)} → ${f(price)}`,
  );
  return { name: it.name as string };
}
