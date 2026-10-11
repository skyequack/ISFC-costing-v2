import type { Queryable } from '../client';
import type { BrandScope } from '../scope';

/**
 * The sites a user may see stock for (D-73): the union of `brand.locations` over the brands in their scope. A site is a plain
 * string shared by whichever brands list it, so this is the only scope stock rows have.
 */
export async function visibleSites(db: Queryable, scope: BrandScope): Promise<string[]> {
  const { rows } = await db.query<{ site: string }>(
    `SELECT DISTINCT unnest(locations) AS site FROM brand WHERE id = ANY($1::text[]) ORDER BY 1`,
    [[...scope.brandIds]],
  );
  return rows.map((r) => r.site);
}

/** True when every brand that lists `site` is in the caller's scope (D-74: actual usage is only shown then). */
export async function seesEveryBrandAt(db: Queryable, scope: BrandScope, site: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM brand WHERE $1 = ANY(locations) AND NOT (id = ANY($2::text[])) LIMIT 1`,
    [site, [...scope.brandIds]],
  );
  return rows.length === 0;
}

export interface StockCell {
  /** the typed/counted quantity; null = nothing stored (not counted) */
  qty: number | null;
  /** receipts of the day that did not come from the grid (uploaded files) */
  other: number;
}

/** Saved counts of one site and day, by ingredient code. */
export async function loadCounts(db: Queryable, site: string, date: string): Promise<Map<string, StockCell>> {
  const { rows } = await db.query(`SELECT code, qty FROM stock_count WHERE site = $1 AND count_date = $2`, [
    site,
    date,
  ]);
  return new Map(rows.map((r) => [r.code as string, { qty: r.qty as number, other: 0 }]));
}

/** Receipts of one site and day: the grid's own row (ref '') and the total of the others, by ingredient code. */
export async function loadReceipts(db: Queryable, site: string, date: string): Promise<Map<string, StockCell>> {
  const { rows } = await db.query(
    `SELECT code,
            sum(qty) FILTER (WHERE ref = '')::double precision AS qty,
            coalesce(sum(qty) FILTER (WHERE ref <> ''), 0)::double precision AS other
       FROM receipt WHERE site = $1 AND receipt_date = $2 GROUP BY code`,
    [site, date],
  );
  return new Map(rows.map((r) => [r.code as string, { qty: r.qty as number | null, other: r.other as number }]));
}
