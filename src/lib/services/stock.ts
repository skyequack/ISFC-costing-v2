import { z } from 'zod';
import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { appendAudit } from '../db/repo/audit';
import { listIngredients } from '../db/repo/ingredients';
import type { BrandScope } from '../db/scope';
import { loadCounts, loadReceipts, visibleSites, type StockCell } from '../db/repo/stock';
import { ApiError } from '../errors';
import { can } from '../permissions';
import { siteStr } from './planning';

export const STOCK_KINDS = ['count', 'receipt'] as const;
export type StockKind = (typeof STOCK_KINDS)[number];

/** Most cells one save may carry (the grid shows ~1000 ingredients). */
export const MAX_STOCK_CELLS = 1500;

export const stockDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a calendar date');

export const stockSaveIn = z.object({
  site: siteStr.refine((s) => s !== '', 'a site is required'),
  date: stockDate,
  kind: z.enum(STOCK_KINDS),
  cells: z
    .array(
      z.object({
        code: z.string().trim().min(1).max(60),
        /** null = clear the stored value (nothing counted / no grid delivery) */
        qty: z.number().finite().min(0).max(1e9).nullable(),
      }),
    )
    .min(1)
    .max(MAX_STOCK_CELLS),
});
export type StockSaveIn = z.output<typeof stockSaveIn>;

export interface StockRow {
  code: string;
  name: string;
  uom: string;
  qty: number | null;
  /** receipts of the day that came from uploaded files (receipt view only) */
  other: number;
}

export interface StockGrid {
  sites: string[];
  site: string;
  date: string;
  kind: StockKind;
  rows: StockRow[];
}

/** Today in UTC plus a day of slack for time zones: a count cannot be dated later than that. */
export function latestStockDate(now = Date.now()): string {
  return new Date(now + 86_400_000).toISOString().slice(0, 10);
}

function needSite(sites: string[], site: string): void {
  if (!sites.includes(site)) throw new ApiError('not_found', 'Not found');
}

/**
 * The grid for one site, day and kind: every ingredient in the caller's scope (shared ones and those of their brands) with the
 * stored quantity, or null where nothing is stored (D-73). A site outside the caller's sites is a 404. `site` '' picks the first.
 */
export async function loadStockGrid(
  db: Queryable,
  scope: BrandScope,
  want: { site: string; date: string; kind: StockKind },
): Promise<StockGrid> {
  const sites = await visibleSites(db, scope);
  const site = want.site === '' ? (sites[0] ?? '') : want.site;
  if (site !== '') needSite(sites, site);
  if (site === '') return { sites, site, date: want.date, kind: want.kind, rows: [] };
  // one after the other: a Queryable may be a single pg Client (a transaction)
  const items = await listIngredients(db, scope);
  const stored = await (want.kind === 'count' ? loadCounts : loadReceipts)(db, site, want.date);
  const rows = items.map((i): StockRow => {
    const cell: StockCell | undefined = stored.get(i.code);
    return { code: i.code, name: i.name, uom: i.uom, qty: cell?.qty ?? null, other: cell?.other ?? 0 };
  });
  return { sites, site, date: want.date, kind: want.kind, rows };
}

/**
 * Save the changed cells of one site and day (D-72/D-73): needs stock.edit; the site must be one of the caller's sites and
 * every code an ingredient in their scope (404 / 422 otherwise, nothing written). A count of 0 is stored (counted empty);
 * null clears. A receipt typed in the grid is the one '' row of the day: null or 0 clears it, uploaded deliveries are not
 * touched. One audit row per save with the numbers, never the values.
 */
export async function saveStock(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  input: StockSaveIn,
): Promise<{ saved: number; cleared: number }> {
  if (!can(user.role, 'stock.edit')) throw new ApiError('forbidden', 'Your role cannot do that');
  if (input.date > latestStockDate()) throw new ApiError('bad_request', 'A date in the future cannot be entered yet');
  needSite(await visibleSites(tx, scope), input.site);

  const seen = new Set<string>();
  for (const c of input.cells) {
    if (seen.has(c.code)) throw new ApiError('bad_request', `${c.code} appears twice`);
    seen.add(c.code);
  }
  const inScope = new Set((await listIngredients(tx, scope)).map((i) => i.code));
  const unknown = input.cells.filter((c) => !inScope.has(c.code)).map((c) => c.code);
  if (unknown.length)
    throw new ApiError('unprocessable', `Not an ingredient you can use: ${unknown.slice(0, 5).join(', ')}`, {
      codes: unknown.slice(0, 50),
    });

  const isCount = input.kind === 'count';
  const keep = input.cells.filter((c) => c.qty !== null && (isCount || c.qty > 0));
  const drop = input.cells.filter((c) => !keep.includes(c)).map((c) => c.code);
  const who = user.name;

  if (keep.length) {
    const table = isCount ? 'stock_count' : 'receipt';
    const dateCol = isCount ? 'count_date' : 'receipt_date';
    await tx.query(
      `INSERT INTO ${table} (site, ${dateCol}, code, qty, ${isCount ? '' : 'ref, '}updated_by)
       SELECT $1, $2::date, t.c, t.q, ${isCount ? '' : "'', "}$5 FROM unnest($3::text[], $4::float8[]) AS t(c, q)
       ON CONFLICT (site, ${dateCol}, code${isCount ? '' : ', ref'}) DO UPDATE
         SET qty = EXCLUDED.qty, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [input.site, input.date, keep.map((c) => c.code), keep.map((c) => c.qty), who],
    );
  }
  if (drop.length)
    await tx.query(
      isCount
        ? `DELETE FROM stock_count WHERE site = $1 AND count_date = $2::date AND code = ANY($3::text[])`
        : `DELETE FROM receipt WHERE site = $1 AND receipt_date = $2::date AND code = ANY($3::text[]) AND ref = ''`,
      [input.site, input.date, drop],
    );

  await appendAudit(
    tx,
    user,
    isCount ? 'Stock counts saved' : 'Receipts saved',
    `${input.site} · ${input.date}: ${keep.length} saved, ${drop.length} cleared`,
  );
  return { saved: keep.length, cleared: drop.length };
}
