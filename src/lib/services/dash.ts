import { z } from 'zod';
import {
  marginAtRisk,
  menuMatrix,
  overTarget,
  pareto,
  type MenuMatrix,
  type OverTargetRow,
  type ParetoRow,
  type RiskRow,
} from '@/domain/dash-analytics';
import { newReqResult, reqExpand, type ReqContext, type ReqEntry } from '@/domain/production/requisition';
import type { Catalog } from '../db/catalog';
import type { Queryable } from '../db/client';
import { canSeeBrand } from '../db/scope';
import { ApiError } from '../errors';
import type { PageCtx } from '../screens/ctx';
import { recipeRows, type RecipeRow } from '../screens/rows';
import { loadProductionRange } from './planning';

const iso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a calendar date');

export const MAX_RANGE_DAYS = 366;

/** Dashboard filters (D-65): empty = all; from <= to; at most MAX_RANGE_DAYS apart. */
export const dashFilters = z
  .object({
    brand: z.string().max(64).default('*'),
    loc: z.string().max(40).default('*'),
    from: iso.optional(),
    to: iso.optional(),
  })
  .superRefine((v, c) => {
    if (v.from && v.to) {
      if (v.from > v.to) c.addIssue({ code: 'custom', path: ['to'], message: 'to must not be before from' });
      else if ((Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 > MAX_RANGE_DAYS)
        c.addIssue({ code: 'custom', path: ['to'], message: `the range is at most ${MAX_RANGE_DAYS} days` });
    }
  });
export type DashFilters = z.output<typeof dashFilters>;

export interface DriverRow {
  code: string;
  name: string;
  uom: string;
  purchaseQty: number;
  cost: number;
}
export interface UnpricedRow {
  code: string;
  name: string;
  portions: number;
  /** distinct ingredients without a price reached by the card */
  missing: number;
}

export interface DashAnalytics {
  filters: { brand: string; loc: string; from: string; to: string };
  sites: string[];
  brandOptions: { id: string; name: string }[];
  /** card id per code, so rows can open the card */
  ids: Record<string, string>;
  portions: number;
  producedCards: number;
  matrix: MenuMatrix;
  risk: { rows: RiskRow[]; total: number; count: number };
  overTarget: OverTargetRow[];
  drivers: { rows: ParetoRow<DriverRow>[]; total: number; count: number };
  unpriced: { rows: UnpricedRow[]; portions: number; count: number };
  flags: { unconvertible: number; truncated: number; unknown: number };
  target: number;
  currency: string;
}

export const TOP_N = 25;

function resolveFilters(ctx: PageCtx, f: DashFilters): { brandIds: string[]; sites: string[] } {
  if (f.brand !== '*' && !ctx.brands.some((b) => b.id === f.brand)) throw new ApiError('not_found', 'Not found');
  const brandIds = f.brand === '*' ? ctx.brands.map((b) => b.id) : [f.brand];
  const sites = [...new Set(ctx.brands.filter((b) => brandIds.includes(b.id)).flatMap((b) => b.locations))];
  if (f.loc !== '*' && !sites.includes(f.loc)) throw new ApiError('not_found', 'Not found');
  return { brandIds, sites };
}

/** Rows the existing dashboard cost sections use: brand filter only (D-65), caller scope always. */
export function dashRows(catalog: Catalog, ctx: PageCtx, brand: string): RecipeRow[] {
  const rows = recipeRows(catalog, ctx.scope);
  return brand === '*' ? rows : rows.filter((r) => r.brandId === brand);
}

/**
 * The analytics the screen and the export both read (D-65…D-67). Brand scope comes from ctx; the filters can only
 * narrow it, and a brand or site outside it is a 404. Cuts and totals are computed over the filtered rows only.
 */
export async function loadDashAnalytics(
  db: Queryable,
  ctx: PageCtx,
  catalog: Catalog,
  f: DashFilters,
): Promise<DashAnalytics> {
  const { brandIds, sites } = resolveFilters(ctx, f);
  const target = catalog.settings.target;
  const menus = dashRows(catalog, ctx, f.brand).filter((r) => r.type === 'menu');
  const byCode = new Map(menus.map((r) => [r.code, r]));

  const prod = (
    await loadProductionRange(db, brandIds, f.from ?? null, f.to ?? null, f.loc === '*' ? null : f.loc)
  ).filter((p) => byCode.has(p.code) && p.portions > 0);
  const portionsOf = new Map(prod.map((p) => [p.code, p.portions]));
  const inputs = menus.map((r) => ({
    code: r.code,
    name: r.name,
    portions: portionsOf.get(r.code) ?? 0,
    sp: r.c.sp,
    food: r.c.food,
  }));

  const risk = marginAtRisk(inputs, target);
  const over = overTarget(
    menus.map((r) => ({ code: r.code, name: r.name, sp: r.c.sp, fcPct: r.c.fcPct })),
    target,
  );

  // theoretical issue value per ingredient and unpriced exposure, from the requisition expansion (D-10/D-28)
  const recipes = [...catalog.context.recipes.values()].filter((r) => {
    const m = catalog.cards[r.code];
    return m && m.id === r.id && canSeeBrand(ctx.scope, m.brandId);
  });
  const reqCtx: ReqContext = { items: catalog.context.items, recipes, conv: catalog.context.conv };
  const recipeOf = new Map(recipes.map((r) => [r.code, r]));
  const acc = new Map<string, ReqEntry>();
  const unpricedRows: UnpricedRow[] = [];
  const flags = { unconvertible: 0, truncated: 0, unknown: 0 };
  for (const p of prod) {
    const rec = recipeOf.get(p.code);
    if (!rec) continue;
    const res = newReqResult();
    reqExpand(rec, p.portions, reqCtx, res);
    for (const e of Object.values(res.acc)) {
      const cur = acc.get(e.code);
      if (cur) {
        cur.qty += e.qty;
        cur.purchaseQty += e.purchaseQty;
        cur.cost += e.cost;
      } else acc.set(e.code, { ...e, from: {} });
    }
    const missing = new Set<string>();
    for (const fl of res.flags) {
      if (fl.kind === 'no-price') missing.add(fl.code);
      else if (fl.kind === 'unconvertible') flags.unconvertible++;
      else if (fl.kind === 'truncated') flags.truncated++;
      else if (fl.kind === 'unknown-code') flags.unknown++;
    }
    if (missing.size)
      unpricedRows.push({ code: p.code, name: byCode.get(p.code)!.name, portions: p.portions, missing: missing.size });
  }
  unpricedRows.sort((a, b) => b.portions - a.portions || a.code.localeCompare(b.code));
  const drivers = pareto(
    [...acc.values()].map((e) => ({
      item: { code: e.code, name: e.name, uom: e.uom, purchaseQty: e.purchaseQty, cost: e.cost },
      cost: e.cost,
    })),
  );

  return {
    filters: { brand: f.brand, loc: f.loc, from: f.from ?? '', to: f.to ?? '' },
    sites,
    brandOptions: ctx.brands.map((b) => ({ id: b.id, name: b.name })),
    ids: Object.fromEntries(menus.map((r) => [r.code, r.id])),
    portions: prod.reduce((a, p) => a + p.portions, 0),
    producedCards: prod.length,
    matrix: menuMatrix(inputs),
    risk: { rows: risk.rows.slice(0, TOP_N), total: risk.total, count: risk.rows.length },
    overTarget: over.slice(0, TOP_N),
    drivers: { rows: drivers.slice(0, TOP_N), total: drivers.reduce((a, d) => a + d.cost, 0), count: drivers.length },
    unpriced: {
      rows: unpricedRows.slice(0, TOP_N),
      portions: unpricedRows.reduce((a, r) => a + r.portions, 0),
      count: unpricedRows.length,
    },
    flags,
    target,
    currency: catalog.settings.currency,
  };
}
