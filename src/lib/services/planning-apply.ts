import { z } from 'zod';
import { lookupFor, menuDemand, weekdayOf } from '@/domain/menu-plans';
import { MENU_DAYS, PLAN_ALIAS } from '@/data';
import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { loadCatalog } from '../db/catalog';
import { appendAudit } from '../db/repo/audit';
import { canSeeBrand, type BrandScope } from '../db/scope';
import { ApiError } from '../errors';
import { can } from '../permissions';
import { applyDayIn, loadMenus, ssemBrandId, menusVisible } from './planning';

/**
 * Legacy applyMenuDay (2239): read the stored headcounts of the day (one site), turn each menu's dishes for that
 * weekday into portions and OVERWRITE production for the demanded dishes only (never clears others).
 */
export async function applyMenuDay(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  input: z.output<typeof applyDayIn>,
): Promise<{ dishes: number; people: number }> {
  if (!can(user.role, 'recipe.edit')) throw new ApiError('forbidden', 'Your role cannot do that');
  if (!(await menusVisible(tx, scope))) throw new ApiError('not_found', 'Not found');
  const ssem = (await ssemBrandId(tx))!;
  const brand = (await tx.query('SELECT locations FROM brand WHERE id = $1', [ssem])).rows[0]!;
  /* D-20: '*' = every site added together (written to the unassigned bucket, as legacy wrote it when no site was picked) */
  const allSites = input.location === '*';
  const writeLoc = allSites ? '' : input.location;
  if (!allSites && input.location !== '' && !(brand.locations as string[]).includes(input.location))
    throw new ApiError('bad_request', `Unknown site ${input.location}`);

  const menus = await loadMenus(tx);
  const paxRows = await tx.query(
    `SELECT menu_id, sum(people)::int AS people FROM menu_pax WHERE month = $1 AND day = $2 AND ($4 OR location = $3) GROUP BY menu_id`,
    [input.month, input.day, input.location, allSites],
  );
  const pax = new Map<string, number>(paxRows.rows.map((r) => [r.menu_id as string, r.people as number]));

  const catalog = await loadCatalog(tx);
  const visible = catalog.context.recipes;
  const usable = [...visible.values()].filter((r) => {
    const c = catalog.cards[r.code];
    return c !== undefined && canSeeBrand(scope, c.brandId);
  });
  const L = lookupFor(catalog.context, usable, PLAN_ALIAS);
  const wd = weekdayOf(input.month, input.day, MENU_DAYS);
  const { tot, miss } = menuDemand(menus, pax, wd, L);
  const entries = Object.values(tot).filter((e) => e.r.type !== 'sub');
  if (!entries.length) throw new ApiError('unprocessable', 'Enter a headcount against at least one menu');

  await tx.query(
    `INSERT INTO production_entry (month, day, location, client_id, recipe_code, portions)
     SELECT $1, $2, $3, '', c, p FROM unnest($4::text[], $5::int[]) AS t(c, p)
     ON CONFLICT (month, day, location, client_id, recipe_code) DO UPDATE SET portions = EXCLUDED.portions`,
    [input.month, input.day, writeLoc, entries.map((e) => e.r.code), entries.map((e) => Math.round(e.q))],
  );
  const people = menus.reduce((a, m) => a + (pax.get(m.id) ?? 0), 0);
  const nMenus = menus.filter((m) => pax.get(m.id)).length;
  const missing = Object.keys(miss);
  await appendAudit(
    tx,
    user,
    'Turned the menus into production',
    `${wd} · ${input.month}-${input.day}${writeLoc ? ` · ${writeLoc}` : ''}: ${people} people across ${nMenus} menus became ${entries.length} dishes to cook` +
      (missing.length ? `. No recipe card for: ${missing.slice(0, 10).join(', ')}` : ''),
  );
  return { dishes: entries.length, people };
}
