import {
  actualUsage,
  rankTva,
  theoreticalUsage,
  tvaRow,
  type TvaRow,
  type Usage,
} from '@/domain/dash-analytics/theoretical';
import type { CostRecipe } from '@/domain/costing';
import type { ReqContext } from '@/domain/production/requisition';
import type { Catalog } from '../db/catalog';
import type { Queryable } from '../db/client';
import { ingredientCodesInScope } from '../db/repo/ingredients';
import { brandsListingSites, countDates, legKey, stockLegs, type Window } from '../db/repo/stock-usage';
import type { BrandScope } from '../db/scope';
import { loadProductionByLocation, loadProductionWindows, type SiteProdRow } from './planning';

/** Rows shown on the screen; the export carries them all (D-74). */
export const TVA_CAP = 100;

export type TvaSiteState =
  /** both counts found: compared over its window */
  | 'counted'
  /** no opening or no closing count in the range, or they fall on the same day */
  | 'no-count'
  /** another brand outside the selection lists this site: stock covers the whole site */
  | 'shared';

export interface TvaSite {
  site: string;
  state: TvaSiteState;
  /** the counts' days (counted sites only): the window is the days after `from` up to and including `to` */
  from?: string;
  to?: string;
}

export interface TvaPanel {
  /** 'actual' = at least one site is compared; 'theoretical' = quantities only */
  mode: 'actual' | 'theoretical';
  /** why there is no actual figure, when mode is 'theoretical' */
  reason: 'client' | 'range' | 'no-count' | 'shared' | null;
  sites: TvaSite[];
  counted: number;
  total: number;
  rows: TvaRow[];
  /** rows before the cap */
  count: number;
  /** production at no site ('' or '*' or a name the brand no longer lists): theoretical only, never compared */
  unallocated: { portions: number; value: number; unpriced: number } | null;
  /** ingredients whose usage is understated by an unconvertible line (no verdict) */
  flagged: number;
}

interface Inputs {
  db: Queryable;
  scope: BrandScope;
  catalog: Catalog;
  reqCtx: ReqContext;
  /** brand ids the filters select (what the caller sees, or the one chosen brand) */
  brandIds: string[];
  brand: string;
  /** every site of the selected brands, and the one(s) the Site filter keeps */
  allSites: string[];
  siteList: string[];
  from: string | null;
  to: string | null;
  /** null = every client, '' = unassigned, else one client id */
  client: string | null;
  menuCodes: ReadonlySet<string>;
  full: boolean;
}

function usageOf(
  rows: readonly SiteProdRow[],
  recipeOf: ReadonlyMap<string, CostRecipe>,
  reqCtx: ReqContext,
  buffer: number,
  into: Map<string, Usage>,
): void {
  for (const p of rows) {
    const rec = recipeOf.get(p.code);
    if (rec) theoreticalUsage(rec, p.portions, reqCtx, buffer, into);
  }
}

const add = (into: Map<string, Usage>, from: Map<string, Usage>): void => {
  for (const [code, u] of from) {
    const cur = into.get(code);
    if (cur) {
      cur.theoretical += u.theoretical;
      cur.extra += u.extra;
      cur.flagged ||= u.flagged;
    } else into.set(code, { ...u });
  }
};

/**
 * Theoretical vs actual usage (D-74). Counts and production are compared site by site over the days between the site's
 * opening and closing count; a site that cannot be compared (no counts, shared with a brand the selection does not cover,
 * a Client filter, no date range) shows theoretical quantities only, and "n/a" is never 0.
 */
export async function loadTva(i: Inputs): Promise<TvaPanel> {
  const { db, scope, catalog, reqCtx, brandIds, from, to } = i;
  const buffer = catalog.settings.buffer;
  const recipeOf = new Map(reqCtx.recipes.map((r) => [r.code, r]));
  const brandFilter = i.brand === '*' ? null : i.brand;

  const range = (await loadProductionByLocation(db, scope, brandFilter, from, to, i.client)).filter((p) =>
    i.menuCodes.has(p.code),
  );

  // which sites can be compared
  const canCompare = from !== null && to !== null && i.client === null;
  const sites: TvaSite[] = [];
  const windows: Window[] = [];
  if (canCompare) {
    const [dates, listing] = await Promise.all([
      countDates(db, i.siteList, from, to),
      brandsListingSites(db, i.siteList),
    ]);
    for (const site of i.siteList) {
      const d = dates.get(site);
      if (!(listing.get(site) ?? []).every((b) => brandIds.includes(b))) sites.push({ site, state: 'shared' });
      else if (!d?.open || !d.close || d.close <= d.open) sites.push({ site, state: 'no-count' });
      else {
        sites.push({ site, state: 'counted', from: d.open, to: d.close });
        windows.push({ site, after: d.open, upto: d.close });
      }
    }
  } else for (const site of i.siteList) sites.push({ site, state: 'no-count' });
  const counted = windows.length;

  // theoretical usage: per counted site over its window, otherwise over the filter range
  const perSite = new Map<string, Map<string, Usage>>();
  const total = new Map<string, Usage>();
  if (counted) {
    const win = (await loadProductionWindows(db, scope, brandFilter, windows)).filter((p) => i.menuCodes.has(p.code));
    for (const w of windows) {
      const m = new Map<string, Usage>();
      usageOf(
        win.filter((p) => p.site === w.site),
        recipeOf,
        reqCtx,
        buffer,
        m,
      );
      perSite.set(w.site, m);
      add(total, m);
    }
  } else
    usageOf(
      range.filter((p) => i.siteList.includes(p.site)),
      recipeOf,
      reqCtx,
      buffer,
      total,
    );

  // actual usage per ingredient across the counted sites
  const actual = new Map<string, number | null>();
  const codes = new Set(total.keys());
  if (counted) {
    const legs = await stockLegs(db, windows);
    const seen = new Set<string>();
    for (const m of [legs.opening, legs.closing, legs.receipts])
      for (const k of m.keys()) seen.add(k.slice(k.indexOf('\u0000') + 1));
    const inScope = await ingredientCodesInScope(db, scope, [...seen]);
    for (const c of seen) if (inScope.has(c)) codes.add(c);
    for (const code of codes) {
      let sum = 0;
      let relevant = false;
      let missing = false;
      for (const w of windows) {
        const k = legKey(w.site, code);
        const o = legs.opening.get(k);
        const c = legs.closing.get(k);
        const r = legs.receipts.get(k) ?? 0;
        const t = perSite.get(w.site)?.get(code)?.theoretical ?? 0;
        if (!(t > 0 || o !== undefined || c !== undefined || r > 0)) continue;
        relevant = true;
        const a = actualUsage(o, r, c);
        if (a === null) missing = true;
        else sum += a;
      }
      if (relevant) actual.set(code, missing ? null : sum);
    }
  }

  const rows: TvaRow[] = [];
  for (const code of codes) {
    const it = reqCtx.items.get(code);
    if (!it) continue;
    const usage = total.get(code) ?? { theoretical: 0, extra: 0, flagged: false };
    const a = actual.get(code) ?? null;
    if (usage.theoretical <= 1e-12 && (a === null || Math.abs(a) <= 1e-12)) continue; // nothing to compare
    rows.push(tvaRow({ code, name: it.name, uom: it.uom, price: it.price, usage, actual: a }));
  }
  const ranked = rankTva(rows);

  // production with no site is never compared (D-74); it only exists in the all-sites view
  let unallocated: TvaPanel['unallocated'] = null;
  if (i.siteList.length === i.allSites.length) {
    const none = range.filter((p) => !i.allSites.includes(p.site));
    if (none.length) {
      const m = new Map<string, Usage>();
      usageOf(none, recipeOf, reqCtx, buffer, m);
      let value = 0;
      let unpriced = 0;
      for (const [code, u] of m) {
        const price = reqCtx.items.get(code)?.price;
        if (price == null) {
          if (u.theoretical > 0) unpriced++;
        } else value += u.theoretical * price;
      }
      unallocated = { portions: none.reduce((a, p) => a + p.portions, 0), value, unpriced };
    }
  }

  const flaggedCount = ranked.filter((r) => r.flagged).length;
  let reason: TvaPanel['reason'] = null;
  if (!counted) {
    reason =
      i.client !== null
        ? 'client'
        : !canCompare
          ? 'range'
          : sites.length > 0 && sites.every((s) => s.state === 'shared')
            ? 'shared'
            : 'no-count';
  }
  return {
    mode: counted ? 'actual' : 'theoretical',
    reason,
    sites,
    counted,
    total: sites.length,
    rows: i.full ? ranked : ranked.slice(0, TVA_CAP),
    count: ranked.length,
    unallocated,
    flagged: flaggedCount,
  };
}
