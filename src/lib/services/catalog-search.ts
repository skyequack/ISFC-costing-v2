import { subUnitCost } from '@/domain/costing';
import { getCatalog } from '../db/catalog-cache';
import type { Queryable } from '../db/client';
import { assertBrandVisible, type BrandScope } from '../db/scope';

export interface PickOption {
  code: string;
  name: string;
  uom: string;
  price: number | null;
  sub: boolean;
}

/**
 * Legacy matches() (3516) for the ingredient picker: sub-recipes of the caller's brands first, then ingredients
 * available to `brandId` (Shared or scoped to it), name-position ranked. `limit` 0 = no limit.
 */
export async function searchPicker(
  db: Queryable,
  scope: BrandScope,
  brandId: string,
  q: string,
  limit: number,
): Promise<{ all: PickOption[]; total: number }> {
  assertBrandVisible(scope, brandId);
  const needle = q.trim().toLowerCase();
  const like = '%' + needle.replace(/[\%_]/g, '\$&') + '%';
  const catalog = await getCatalog();

  const subRows = await db.query(
    `SELECT code, name, sub_uom FROM recipe
      WHERE type = 'SUB' AND deleted_at IS NULL AND code <> '' AND brand_id = ANY($1::text[])
        AND ($2 = '' OR lower(code) LIKE $3 OR lower(name) LIKE $3) ORDER BY code`,
    [[...scope.brandIds], needle, like],
  );
  const subs: PickOption[] = subRows.rows.map((r) => {
    const rec = catalog.context.recipes.get(r.code as string);
    return {
      code: r.code as string,
      name: r.name as string,
      uom: (r.sub_uom as string) || 'Gram',
      price: rec ? subUnitCost(rec, catalog.context).v : null,
      sub: true,
    };
  });

  const itemRows = await db.query(
    `SELECT i.code, i.name, i.uom, i.price, count(*) OVER () AS total FROM ingredient i
      WHERE (NOT EXISTS (SELECT 1 FROM item_brand_scope s WHERE s.ingredient_id = i.id)
             OR EXISTS (SELECT 1 FROM item_brand_scope s WHERE s.ingredient_id = i.id AND s.brand_id = $1))
        AND ($2 = '' OR lower(i.code) LIKE $3 OR lower(i.name) LIKE $3)
      ORDER BY CASE WHEN $2 = '' OR strpos(lower(i.name), $2) = 0 THEN 99 ELSE strpos(lower(i.name), $2) END, length(i.name), i.code
      LIMIT $4`,
    [brandId, needle, like, limit > 0 ? Math.max(limit - subs.length, 0) : 100000],
  );
  const items: PickOption[] = itemRows.rows.map((r) => ({ code: r.code, name: r.name, uom: r.uom, price: r.price, sub: false }));
  const itemTotal = itemRows.rows[0] ? Number(itemRows.rows[0].total) : 0;
  const all = limit > 0 ? [...subs, ...items].slice(0, limit) : [...subs, ...items];
  return { all, total: subs.length + (itemTotal || (await countItems(db, brandId, needle, like))) };
}

async function countItems(db: Queryable, brandId: string, needle: string, like: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM ingredient i
      WHERE (NOT EXISTS (SELECT 1 FROM item_brand_scope s WHERE s.ingredient_id = i.id)
             OR EXISTS (SELECT 1 FROM item_brand_scope s WHERE s.ingredient_id = i.id AND s.brand_id = $1))
        AND ($2 = '' OR lower(i.code) LIKE $3 OR lower(i.name) LIKE $3)`,
    [brandId, needle, like],
  );
  return Number(r.rows[0]!.n);
}
