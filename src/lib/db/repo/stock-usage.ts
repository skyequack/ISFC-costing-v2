import type { Queryable } from '../client';

/** Read side of the dashboard's theoretical-vs-actual panel (D-74): counts, receipts and which brands list a site. */

export interface CountDates {
  /** latest count day on or before the range start; null = none */
  open: string | null;
  /** latest count day on or before the range end; null = none */
  close: string | null;
}

const D = (c: string) => `to_char(${c}, 'YYYY-MM-DD')`;

/** Per site, the opening and closing count days for [from, to] (one query; sites with no count at all are absent). */
export async function countDates(
  db: Queryable,
  sites: readonly string[],
  from: string,
  to: string,
): Promise<Map<string, CountDates>> {
  if (!sites.length) return new Map();
  const { rows } = await db.query(
    `SELECT site,
            ${D('max(count_date) FILTER (WHERE count_date <= $2::date)')} AS open,
            ${D('max(count_date) FILTER (WHERE count_date <= $3::date)')} AS close
       FROM stock_count WHERE site = ANY($1::text[]) GROUP BY site`,
    [[...sites], from, to],
  );
  return new Map(
    rows.map((r) => [r.site as string, { open: r.open as string | null, close: r.close as string | null }]),
  );
}

export interface Window {
  site: string;
  /** opening count day (exclusive start of the window) */
  after: string;
  /** closing count day (inclusive end) */
  upto: string;
}

export interface StockLegs {
  /** `${site}\u0000${code}` -> quantity at the opening count */
  opening: Map<string, number>;
  closing: Map<string, number>;
  /** receipts dated after the opening count up to the closing count, summed */
  receipts: Map<string, number>;
}

export const legKey = (site: string, code: string) => `${site}\u0000${code}`;

/** Opening counts, closing counts and receipts of each site's own window, three queries for all sites. */
export async function stockLegs(db: Queryable, windows: readonly Window[]): Promise<StockLegs> {
  const out: StockLegs = { opening: new Map(), closing: new Map(), receipts: new Map() };
  if (!windows.length) return out;
  const sites = windows.map((w) => w.site);
  const afters = windows.map((w) => w.after);
  const upto = windows.map((w) => w.upto);
  const count = (days: string[]) =>
    db.query(
      `SELECT c.site, c.code, c.qty FROM stock_count c
         JOIN unnest($1::text[], $2::date[]) AS w(site, d) ON c.site = w.site AND c.count_date = w.d`,
      [sites, days],
    );
  const [o, c, r] = await Promise.all([
    count(afters),
    count(upto),
    db.query(
      `SELECT r.site, r.code, sum(r.qty)::double precision AS qty FROM receipt r
         JOIN unnest($1::text[], $2::date[], $3::date[]) AS w(site, a, b)
           ON r.site = w.site AND r.receipt_date > w.a AND r.receipt_date <= w.b
        GROUP BY r.site, r.code`,
      [sites, afters, upto],
    ),
  ]);
  for (const x of o.rows) out.opening.set(legKey(x.site as string, x.code as string), x.qty as number);
  for (const x of c.rows) out.closing.set(legKey(x.site as string, x.code as string), x.qty as number);
  for (const x of r.rows) out.receipts.set(legKey(x.site as string, x.code as string), x.qty as number);
  return out;
}

/**
 * Every brand that lists each site, whether or not the caller can see it: stock covers the whole site, so a comparison is
 * only fair when the caller's selection covers all of them. Only ids leave this function, never names.
 */
export async function brandsListingSites(db: Queryable, sites: readonly string[]): Promise<Map<string, string[]>> {
  if (!sites.length) return new Map();
  const { rows } = await db.query(
    `SELECT s AS site, array_agg(b.id ORDER BY b.id) AS brand_ids
       FROM brand b, unnest(b.locations) AS s WHERE s = ANY($1::text[]) GROUP BY s`,
    [[...sites]],
  );
  return new Map(rows.map((r) => [r.site as string, r.brand_ids as string[]]));
}
