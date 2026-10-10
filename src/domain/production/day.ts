/**
 * Daily production arithmetic — port of legacy pQty / pSection / pDayTotals / reqForDay (2062-2121) with D-20:
 * "all sites" = the sum of every site plus the unassigned bucket ('' location). Pure; requisition math stays in ./requisition.
 */
import type { CostRecipe } from '../costing';
import { newReqResult, reqExpand, type ReqContext, type ReqEntry, type ReqFlag, type ReqResult } from './requisition';

export interface ProdEntry {
  day: string;
  /** '' = the unassigned bucket (legacy plain-code entries). */
  location: string;
  code: string;
  portions: number;
}

/** Day -> code -> location -> portions. */
export class ProdIndex {
  private m = new Map<string, Map<string, Map<string, number>>>();
  constructor(entries: Iterable<ProdEntry>) {
    for (const e of entries) {
      const d = this.m.get(e.day) ?? new Map<string, Map<string, number>>();
      const c = d.get(e.code) ?? new Map<string, number>();
      c.set(e.location, (c.get(e.location) ?? 0) + e.portions);
      d.set(e.code, c);
      this.m.set(e.day, d);
    }
  }
  /** Legacy pQty: one site when `loc` is a site name ('' = unassigned only); '*' = every site plus unassigned (D-20). */
  qty(day: string, code: string, loc: string): number {
    const c = this.m.get(day)?.get(code);
    if (!c) return 0;
    if (loc !== '*') return c.get(loc) ?? 0;
    let t = 0;
    for (const v of c.values()) t += v;
    return t;
  }
  /** Per-site breakdown of a card on a day (for the "NIC 40 · NEOM 25" note). */
  bySite(day: string, code: string): [string, number][] {
    return [...(this.m.get(day)?.get(code)?.entries() ?? [])].filter(([, q]) => q > 0);
  }
}

export interface ProdCard {
  recipe: CostRecipe;
  /** cost(card).food — the per-portion cost (pCost). */
  food: number;
  section: string;
  brandId: string;
}

export function dayTotals(
  cards: ReadonlyArray<ProdCard>,
  idx: ProdIndex,
  day: string,
  loc: string,
): { sec: Record<string, number>; total: number; portions: number } {
  const sec: Record<string, number> = {};
  let total = 0,
    portions = 0;
  for (const c of cards) {
    const q = idx.qty(day, c.recipe.code, loc);
    if (!q) continue;
    const v = q * (c.food || 0);
    sec[c.section] = (sec[c.section] || 0) + v;
    total += v;
    portions += q;
  }
  return { sec, total, portions };
}

export interface DayRequisition {
  bySec: Record<string, { card: ProdCard; portions: number; per: Record<string, ReqEntry> }[]>;
  all: Record<string, ReqEntry>;
  flags: ReqFlag[];
}

/** Legacy reqForDay (2111): what the kitchen must draw to cook the day's numbers (D-10 conversion-aware valuation). */
export function reqForDay(
  cards: ReadonlyArray<ProdCard>,
  idx: ProdIndex,
  day: string,
  loc: string,
  ctx: ReqContext,
): DayRequisition {
  const bySec: DayRequisition['bySec'] = {};
  const all: ReqResult = newReqResult();
  for (const c of cards) {
    const p = idx.qty(day, c.recipe.code, loc);
    if (!p) continue;
    const per = newReqResult();
    reqExpand(c.recipe, p, ctx, per, 0);
    (bySec[c.section] = bySec[c.section] || []).push({ card: c, portions: p, per: per.acc });
    reqExpand(c.recipe, p, ctx, all, 0);
  }
  return { bySec, all: all.acc, flags: all.flags };
}

export const byCostDesc = (a: ReqEntry, b: ReqEntry) => b.cost - a.cost;
export const byQtyDesc = (a: ReqEntry, b: ReqEntry) => b.qty - a.qty;

export const daysIn = (month: string): number => {
  const [y, mo] = month.split('-').map(Number) as [number, number];
  return new Date(y, mo, 0).getDate();
};
export const pad2 = (n: number) => String(n).padStart(2, '0');
