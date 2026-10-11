import { lineCost, num } from '@/domain/costing';
import type { Catalog } from '../db/catalog';
import type { Queryable } from '../db/client';
import type { IngredientDto } from '../db/repo/ingredients';
import { canSeeBrand, type BrandScope } from '../db/scope';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM';
export interface HealthRow {
  sev: Severity;
  where: string;
  problem: string;
  why: string;
}

/** Legacy vHealth (4318) live checks, over the caller's items and cards. Wording of the "needs conversion" row corrected (bug 22). */
export function healthRows(catalog: Catalog, scope: BrandScope, items: IngredientDto[]): HealthRow[] {
  const live: HealthRow[] = [];
  for (const i of items)
    if (i.price == null)
      live.push({
        sev: 'CRITICAL',
        where: `${i.code} ${i.name}`,
        problem: 'No price on file',
        why: 'Any card using it costs at zero.',
      });
  for (const r of catalog.context.recipes.values()) {
    const meta = catalog.cards[r.code];
    if (!meta || meta.id !== r.id || !canSeeBrand(scope, meta.brandId)) continue;
    for (const l of r.lines) {
      if (!l.code) continue;
      const c = lineCost(l, catalog.context);
      if (c.kind === 'none')
        live.push({
          sev: 'CRITICAL',
          where: r.name,
          problem: `Unknown code ${l.code}`,
          why: 'That line contributes nothing.',
        });
      else if (c.needConv)
        live.push({
          sev: 'HIGH',
          where: r.name,
          problem: `${l.code} priced per ${c.uom} but the recipe asks for ${l.unit}`,
          why: 'No conversion exists, so the line costs nothing.',
        });
    }
    if (r.type === 'menu' && !num(r.price))
      live.push({ sev: 'MEDIUM', where: r.name, problem: 'No sales price', why: 'Food cost % cannot be measured.' });
    if (r.type === 'sub' && !num(r.batchOut))
      live.push({ sev: 'HIGH', where: r.name, problem: 'No batch output', why: 'Cost per unit cannot be worked out.' });
    if (!r.code)
      live.push({
        sev: 'MEDIUM',
        where: r.name,
        problem: 'No recipe code',
        why: 'It cannot be called by another card.',
      });
  }
  return live;
}

const SHOWN = 10;

/**
 * Checks that need the database (D-83): production naming a client that is gone or belongs to another brand (for the
 * caller's brands), and, for the General Manager only (stock has no brand scope), stock counts or receipts at a site no
 * brand lists or at a code that is not an ingredient.
 */
export async function dbHealthRows(db: Queryable, scope: BrandScope, admin: boolean): Promise<HealthRow[]> {
  const out: HealthRow[] = [];
  const orphan = Number(
    (
      await db.query(
        `SELECT count(*) AS n FROM production_entry p
           JOIN recipe r ON r.code = p.recipe_code AND r.deleted_at IS NULL
           LEFT JOIN client c ON c.id = p.client_id
          WHERE p.client_id <> '' AND r.brand_id = ANY($1::text[]) AND (c.id IS NULL OR c.brand_id <> r.brand_id)`,
        [[...scope.brandIds]],
      )
    ).rows[0]!.n,
  );
  if (orphan)
    out.push({
      sev: 'HIGH',
      where: 'Production figures',
      problem: `${orphan} row${orphan === 1 ? '' : 's'} name a client that no longer exists or belongs to another brand`,
      why: 'They appear under no client you can choose, so they are easy to miss.',
    });
  if (!admin) return out;
  const { rows } = await db.query(
    `SELECT 'site' AS kind, site AS what, count(*)::int AS n
       FROM (SELECT site FROM stock_count UNION ALL SELECT site FROM receipt) s
      WHERE NOT EXISTS (SELECT 1 FROM brand b WHERE s.site = ANY(b.locations)) GROUP BY site
     UNION ALL
     SELECT 'code', code, count(*)::int
       FROM (SELECT code FROM stock_count UNION ALL SELECT code FROM receipt) s
      WHERE NOT EXISTS (SELECT 1 FROM ingredient i WHERE i.code = s.code) GROUP BY code
     ORDER BY 1, 2`,
  );
  for (const kind of ['site', 'code'] as const) {
    const mine = rows.filter((r) => r.kind === kind);
    for (const r of mine.slice(0, SHOWN))
      out.push({
        sev: 'HIGH',
        where: 'Stock',
        problem:
          kind === 'site'
            ? `${r.n} count or receipt row${r.n === 1 ? '' : 's'} at ${r.what}, a site no brand lists`
            : `${r.n} count or receipt row${r.n === 1 ? '' : 's'} for ${r.what}, which is not an ingredient`,
        why:
          kind === 'site'
            ? 'No screen offers that site any more, so these figures cannot be seen or corrected.'
            : 'No stock screen offers that code, so these figures cannot be seen or corrected.',
      });
    if (mine.length > SHOWN)
      out.push({
        sev: 'MEDIUM',
        where: 'Stock',
        problem: `${mine.length - SHOWN} more ${kind === 'site' ? 'sites' : 'codes'} with the same problem`,
        why: 'Only the first ten are listed.',
      });
  }
  return out;
}
