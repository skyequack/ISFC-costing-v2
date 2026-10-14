import { z } from 'zod';
import {
  fcHistogram,
  marginAtRisk,
  menuMatrix,
  overTarget,
  pareto,
  type FcBin,
  type MenuMatrix,
  type OverTargetRow,
  type ParetoRow,
  type RiskRow,
} from '@/domain/dash-analytics';
import { newReqResult, reqExpand, type ReqContext, type ReqEntry } from '@/domain/production/requisition';
import type { Catalog } from '../db/catalog';
import type { Queryable } from '../db/client';
import { listClients, type ClientDto } from '../db/repo/clients';
import { canSeeBrand } from '../db/scope';
import { ApiError } from '../errors';
import type { PageCtx } from '../screens/ctx';
import { recipeRows, type RecipeRow } from '../screens/rows';
import { loadTva, type TvaPanel } from './dash-stock';
import { loadAsOf } from './asof';
import { loadProductionDaily, loadProductionRange } from './planning';

const iso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a calendar date');

export const MAX_RANGE_DAYS = 366;
/** costing periods (stretches of days with no revision or price change) one dashboard request may use (D-100, B3) */
export const MAX_PERIODS = 60;

/** Dashboard filters (D-65): empty = all; from <= to; at most MAX_RANGE_DAYS apart. */
export const dashFilters = z
  .object({
    brand: z.string().max(64).default('*'),
    loc: z.string().max(40).default('*'),
    /** '*' = every client, 'none' = unassigned, or a client id (D-71, D-74) */
    client: z.string().max(64).default('*'),
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
  filters: { brand: string; loc: string; client: string; from: string; to: string };
  sites: string[];
  brandOptions: { id: string; name: string }[];
  /** clients of the selected brand(s) the caller can see (D-71); empty = hide the Client filter */
  clientOptions: { id: string; name: string; brandId: string; active: boolean }[];
  /** theoretical vs actual usage (D-74) */
  tva: TvaPanel;
  /** card id per code, so rows can open the card */
  ids: Record<string, string>;
  portions: number;
  producedCards: number;
  matrix: MenuMatrix;
  /** portions per food-cost band, split at the target (D-84) */
  spread: FcBin[];
  risk: { rows: RiskRow[]; total: number; count: number };
  overTarget: OverTargetRow[];
  drivers: { rows: ParetoRow<DriverRow>[]; total: number; count: number };
  unpriced: { rows: UnpricedRow[]; portions: number; count: number };
  flags: { unconvertible: number; truncated: number; unknown: number };
  target: number;
  currency: string;
}

export const TOP_N = 25;

function resolveFilters(
  ctx: PageCtx,
  f: DashFilters,
  clients: ClientDto[],
): { sites: string[]; brandIds: string[]; clientOptions: DashAnalytics['clientOptions']; clientSql: string | null } {
  if (f.brand !== '*' && !ctx.brands.some((b) => b.id === f.brand)) throw new ApiError('not_found', 'Not found');
  const brandIds = f.brand === '*' ? ctx.brands.map((b) => b.id) : [f.brand];
  const sites = [...new Set(ctx.brands.filter((b) => brandIds.includes(b.id)).flatMap((b) => b.locations))];
  if (f.loc !== '*' && !sites.includes(f.loc)) throw new ApiError('not_found', 'Not found');
  const clientOptions = clients
    .filter((c) => brandIds.includes(c.brandId))
    .map((c) => ({ id: c.id, name: c.name, brandId: c.brandId, active: c.active }));
  if (f.client !== '*' && f.client !== 'none' && !clientOptions.some((c) => c.id === f.client))
    throw new ApiError('not_found', 'Not found');
  return { sites, brandIds, clientOptions, clientSql: f.client === '*' ? null : f.client === 'none' ? '' : f.client };
}

/** What the requisition expansion reads: library items, the cards the caller can see (list order matters), conversions. */
export function buildReqCtx(catalog: Catalog, ctx: PageCtx): ReqContext {
  const recipes = [...catalog.context.recipes.values()].filter((r) => {
    const m = catalog.cards[r.code];
    return m && m.id === r.id && canSeeBrand(ctx.scope, m.brandId);
  });
  return { items: catalog.context.items, recipes, conv: catalog.context.conv };
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
  /** the already costed rows of dashRows(catalog, ctx, f.brand), when the caller has them (costing every card is the heavy part) */
  rowsIn?: RecipeRow[],
  /** the export carries every theoretical-vs-actual row; the screen the first TVA_CAP */
  opts: { full?: boolean } = {},
): Promise<DashAnalytics> {
  const { sites, brandIds, clientOptions, clientSql } = resolveFilters(ctx, f, await listClients(db, ctx.scope));
  const target = catalog.settings.target;
  const menus = (rowsIn ?? dashRows(catalog, ctx, f.brand)).filter((r) => r.type === 'menu');
  const byCode = new Map(menus.map((r) => [r.code, r]));

  // Costing periods (D-100, B3): days are costed with the revision and prices in force that day; days that cost alike share
  // one catalog. With no history in the range this is ONE period on the current catalog, exactly the figures before dates existed.
  const asof = await loadAsOf(db, catalog, f.from ?? '0001-01-01');
  const range = [
    ctx.scope,
    f.brand === '*' ? null : f.brand,
    f.from ?? null,
    f.to ?? null,
    f.loc === '*' ? null : f.loc,
    clientSql,
  ] as const;
  let periods: { cat: Catalog; rows: { code: string; portions: number }[] }[];
  if (!asof.active) periods = [{ cat: catalog, rows: await loadProductionRange(db, ...range) }];
  else {
    const byCat = new Map<Catalog, Map<string, number>>();
    for (const d of await loadProductionDaily(db, ...range)) {
      const cat = d.day ? asof.catalogFor(d.day) : catalog;
      const m = byCat.get(cat) ?? new Map<string, number>();
      m.set(d.code, (m.get(d.code) ?? 0) + d.portions);
      byCat.set(cat, m);
    }
    if (byCat.size > MAX_PERIODS)
      throw new ApiError(
        'unprocessable',
        `Costing changed in more than ${MAX_PERIODS} periods inside that range - narrow the dates`,
      );
    periods = [...byCat].map(([cat, m]) => ({ cat, rows: [...m].map(([code, portions]) => ({ code, portions })) }));
    if (!periods.length) periods = [{ cat: catalog, rows: [] }];
  }
  const menusOf = (cat: Catalog) =>
    cat === catalog ? menus : dashRows(cat, ctx, f.brand).filter((r) => r.type === 'menu');
  const per = periods.map((pd) => {
    const ms = menusOf(pd.cat);
    const by = new Map(ms.map((r) => [r.code, r]));
    return { cat: pd.cat, ms, by, prod: pd.rows.filter((p) => byCode.has(p.code) && by.has(p.code) && p.portions > 0) };
  });
  const portionsOf = new Map<string, number>();
  for (const pr of per) for (const p of pr.prod) portionsOf.set(p.code, (portionsOf.get(p.code) ?? 0) + p.portions);
  const prod = [...portionsOf].map(([code, portions]) => ({ code, portions }));
  // one row per card; across several periods price, cost and food-cost % are portion-weighted (a card with no portions keeps the current ones)
  const weighted = (r: RecipeRow) => {
    const P = portionsOf.get(r.code) ?? 0;
    if (per.length === 1) {
      const g = per[0]!.by.get(r.code) ?? r;
      return { sp: g.c.sp, food: g.c.food, fcPct: g.c.fcPct };
    }
    if (!(P > 0)) return { sp: r.c.sp, food: r.c.food, fcPct: r.c.fcPct };
    let sp = 0;
    let food = 0;
    let fc = 0;
    let fcW = 0;
    for (const pr of per) {
      const q = pr.prod.find((x) => x.code === r.code)?.portions ?? 0;
      const g = pr.by.get(r.code);
      if (!(q > 0) || !g) continue;
      sp += q * g.c.sp;
      food += q * g.c.food;
      if (g.c.fcPct !== null && Number.isFinite(g.c.fcPct)) {
        fc += q * g.c.fcPct;
        fcW += q;
      }
    }
    return { sp: sp / P, food: food / P, fcPct: fcW > 0 ? fc / fcW : null };
  };
  const wRows = menus.map((r) => ({ r, w: weighted(r) }));
  const inputs = wRows.map(({ r, w }) => ({
    code: r.code,
    name: r.name,
    portions: portionsOf.get(r.code) ?? 0,
    sp: w.sp,
    food: w.food,
  }));

  const risk = marginAtRisk(inputs, target);
  const over = overTarget(
    menus.map((r) => ({ code: r.code, name: r.name, sp: r.c.sp, fcPct: r.c.fcPct })),
    target,
  );

  // theoretical issue value per ingredient and unpriced exposure, from the requisition expansion (D-10/D-28)
  const reqCtx = buildReqCtx(catalog, ctx);
  const acc = new Map<string, ReqEntry>();
  const unpricedBy = new Map<string, { name: string; portions: number; missing: Set<string> }>();
  const flags = { unconvertible: 0, truncated: 0, unknown: 0 };
  for (const pr of per) {
    const pCtx = pr.cat === catalog ? reqCtx : buildReqCtx(pr.cat, ctx);
    const recipeOf = new Map(pCtx.recipes.map((r) => [r.code, r]));
    for (const p of pr.prod) {
      const rec = recipeOf.get(p.code);
      if (!rec) continue;
      const res = newReqResult();
      reqExpand(rec, p.portions, pCtx, res);
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
      if (missing.size) {
        const u = unpricedBy.get(p.code) ?? { name: byCode.get(p.code)!.name, portions: 0, missing: new Set<string>() };
        u.portions += p.portions;
        for (const m of missing) u.missing.add(m);
        unpricedBy.set(p.code, u);
      }
    }
  }
  const unpricedRows: UnpricedRow[] = [...unpricedBy].map(([code, u]) => ({
    code,
    name: u.name,
    portions: u.portions,
    missing: u.missing.size,
  }));
  unpricedRows.sort((a, b) => b.portions - a.portions || a.code.localeCompare(b.code));
  const drivers = pareto(
    [...acc.values()].map((e) => ({
      item: { code: e.code, name: e.name, uom: e.uom, purchaseQty: e.purchaseQty, cost: e.cost },
      cost: e.cost,
    })),
  );

  const tva = await loadTva({
    db,
    scope: ctx.scope,
    catalog,
    reqCtx,
    brandIds,
    brand: f.brand,
    allSites: sites,
    siteList: f.loc === '*' ? sites : [f.loc],
    from: f.from ?? null,
    to: f.to ?? null,
    client: clientSql,
    menuCodes: new Set(byCode.keys()),
    full: opts.full === true,
  });

  return {
    filters: { brand: f.brand, loc: f.loc, client: f.client, from: f.from ?? '', to: f.to ?? '' },
    sites,
    brandOptions: ctx.brands.map((b) => ({ id: b.id, name: b.name })),
    clientOptions,
    tva,
    ids: Object.fromEntries(menus.map((r) => [r.code, r.id])),
    portions: prod.reduce((a, p) => a + p.portions, 0),
    producedCards: prod.length,
    matrix: menuMatrix(inputs),
    spread: fcHistogram(
      wRows.map(({ r, w }) => ({ fcPct: w.fcPct, portions: portionsOf.get(r.code) ?? 0 })),
      target,
    ),
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
