/**
 * Menu plan domain — port of legacy 1637-1716 (plan matcher, plan cost) and 2200-2240 / 1738-1756 (menu preview,
 * demand, preparation). Pure: no React / DB. Requisition math stays in ../production (separate module).
 */
import { cost, num, type CostContext, type CostRecipe } from '../costing';
import { newReqResult, reqExpand, type ReqContext, type ReqEntry, type ReqFlag } from '../production/requisition';

export type CellKind = 'ITEM' | 'RECIPE' | 'NONE';
export interface PlanCell {
  label: string;
  kind: CellKind;
  code: string | null;
}
export interface PlanRow {
  meal: string;
  cells: Record<string, PlanCell | undefined>;
}
export interface PlanMenu {
  id: string;
  name: string;
  days: string[];
  rows: PlanRow[];
}

export const MEAL_ORDER = ['BREAKFAST', 'LUNCH', 'LUNCH MUSLIM', 'VEGGI', 'VEGGI HINDOS', 'DINNER', 'MEAL'];
export function mealRank(m: string): number {
  const i = MEAL_ORDER.indexOf((m || '').toUpperCase().replace(/\s+/g, ' ').trim());
  return i < 0 ? 99 : i;
}
export function planFamily(name: string): string {
  return (name || '').split(/[\s-]+/)[0]!.toUpperCase();
}

const PLAN_STOP = ['or', 'with', 'and', 'the', 'of', 'a', 'portions', 'portion', 'same'];
function planStem(w: string): string {
  return w.length > 3 && w.slice(-1) === 's' ? w.slice(0, -1) : w;
}
export function planTok(s: string): string[] {
  const o: Record<string, 1> = {};
  String(s || '')
    .toLowerCase()
    .replace(/[a-z0-9]+/g, (m) => {
      const t = planStem(m);
      if (PLAN_STOP.indexOf(t) < 0) o[t] = 1;
      return m;
    });
  return Object.keys(o);
}

/**
 * Legacy planFindCard (1672): alias first, then a token match needing >= 2 shared words and a 0.7 score.
 * `recipes` is every card the caller may use (code + name). Results are memoised per matcher.
 */
export function createCardMatcher(
  recipes: ReadonlyArray<{ code: string; name: string }>,
  alias: Readonly<Record<string, string>>,
): (name: string) => string | null {
  const upper = new Set(recipes.map((r) => (r.code || '').toUpperCase()));
  const toks = recipes.map((r) => ({ code: r.code, c: planTok(r.name) }));
  const cache = new Map<string, string | null>();
  return (name) => {
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    const al =
      alias[
        String(name || '')
          .trim()
          .toUpperCase()
      ];
    if (al && upper.has(al.toUpperCase())) {
      cache.set(name, al);
      return al;
    }
    const t = planTok(name);
    let best: string | null = null,
      bs = 0;
    if (t.length >= 2)
      for (const r of toks) {
        const c = r.c;
        if (c.length < 2) continue;
        const inter = c.filter((x) => t.indexOf(x) >= 0).length;
        if (inter < 2) continue;
        const cInT = c.every((x) => t.indexOf(x) >= 0),
          tInC = t.every((x) => c.indexOf(x) >= 0);
        let sc: number;
        if (cInT) sc = 1 + inter / 100;
        else if (tInC && c.length - t.length <= 1) sc = 0.95;
        else {
          sc = inter / (t.length + c.length - inter);
          if (sc < 0.7) continue;
        }
        if (sc > bs) {
          bs = sc;
          best = r.code;
        }
      }
    cache.set(name, best);
    return best;
  };
}

export interface PlanLookup {
  ctx: CostContext;
  /** Card by UPPER-CASED code (legacy compares upper-cased). */
  cardByUpper: ReadonlyMap<string, CostRecipe>;
  findCard: (name: string) => string | null;
}

export function lookupFor(
  ctx: CostContext,
  recipes: ReadonlyArray<CostRecipe>,
  alias: Readonly<Record<string, string>>,
): PlanLookup {
  const cardByUpper = new Map<string, CostRecipe>();
  for (const r of recipes) cardByUpper.set((r.code || '').toUpperCase(), r);
  return { ctx, cardByUpper, findCard: createCardMatcher(recipes, alias) };
}

export interface PlanCostResult {
  v: number | null;
  src: string;
}

/** Legacy planCost (1693). Every cell is a pointer, never a stored figure. */
export function planCost(cell: PlanCell | undefined, L: PlanLookup): PlanCostResult {
  if (!cell || !cell.code) return { v: null, src: 'not matched' };
  if (cell.kind === 'RECIPE') {
    const r = L.cardByUpper.get(cell.code.toUpperCase());
    if (!r) return { v: null, src: 'card missing' };
    return { v: cost(r, L.ctx).food, src: 'card' };
  }
  const it = L.ctx.items.get(cell.code);
  if (it && it.price != null && num(it.price) !== 0) return { v: num(it.price), src: 'item' };
  const nc = L.findCard(cell.label);
  if (nc) {
    const r = L.cardByUpper.get(nc.toUpperCase());
    if (r) return { v: cost(r, L.ctx).food, src: 'new card' };
  }
  if (!it) return { v: null, src: 'item missing' };
  return { v: null, src: 'no price' };
}

export function planDay(m: PlanMenu, dy: string, L: PlanLookup): { tot: number; priced: number; unp: number } {
  let t = 0,
    p = 0,
    u = 0;
  for (const r of m.rows || []) {
    const c = r.cells[dy];
    if (!c) continue;
    const q = planCost(c, L);
    if (q.v == null || q.v === 0) u++;
    else {
      p++;
      t += q.v;
    }
  }
  return { tot: t, priced: p, unp: u };
}
export function planWeek(m: PlanMenu, L: PlanLookup): number {
  return (m.days || []).reduce((a, dy) => a + planDay(m, dy, L).tot, 0);
}

/** Legacy menuPreview (2205): card cells use their code, others go through the fuzzy matcher. */
export function menuPreview(
  m: PlanMenu,
  weekday: string,
  L: PlanLookup,
): { hit: { meal: string; r: CostRecipe }[]; miss: string[] } {
  const hit: { meal: string; r: CostRecipe }[] = [];
  const miss: string[] = [];
  for (const row of m.rows || []) {
    const cell = row.cells[weekday];
    if (!cell) continue;
    let code = cell.kind === 'RECIPE' ? cell.code : null;
    if (!code) {
      const f = L.findCard(cell.label);
      if (f) code = f;
    }
    const r = code ? L.cardByUpper.get(code.toUpperCase()) : undefined;
    if (r) hit.push({ meal: row.meal, r });
    else miss.push(cell.label);
  }
  return { hit, miss };
}

export interface DemandEntry {
  r: CostRecipe;
  q: number;
  from: Record<string, number>;
}
/** Legacy menuDemand (2228): dish -> total people to cook for, plus dishes with no card. */
export function menuDemand(
  menus: ReadonlyArray<PlanMenu>,
  pax: ReadonlyMap<string, number>,
  weekday: string,
  L: PlanLookup,
): { tot: Record<string, DemandEntry>; miss: Record<string, number> } {
  const tot: Record<string, DemandEntry> = {};
  const miss: Record<string, number> = {};
  for (const m of menus) {
    const p = pax.get(m.id) ?? 0;
    if (!p) continue;
    const { hit, miss: ms } = menuPreview(m, weekday, L);
    for (const h of hit) {
      const e = tot[h.r.code] || (tot[h.r.code] = { r: h.r, q: 0, from: {} });
      e.q += p;
      e.from[m.name] = p;
    }
    for (const n of ms) miss[n] = (miss[n] || 0) + p;
  }
  return { tot, miss };
}

export interface PrepDish {
  r: CostRecipe;
  pax: number;
  meals: Record<string, true>;
  from: Record<string, number>;
}
export interface PrepResult {
  rows: ReqEntry[];
  dishes: PrepDish[];
  missing: Record<string, number>;
  menus: { id: string; name: string; pax: number; dishes: number; missing: number }[];
  people: number;
  flags: ReqFlag[];
}

/** Legacy prepDemand (1738): one accumulator across every menu that has a headcount. */
export function prepDemand(
  menus: ReadonlyArray<PlanMenu>,
  pax: ReadonlyMap<string, number>,
  weekday: string,
  L: PlanLookup,
  req: ReqContext,
): PrepResult {
  const res = newReqResult();
  const dishes: Record<string, PrepDish> = {};
  const missing: Record<string, number> = {};
  const used: PrepResult['menus'] = [];
  for (const m of menus) {
    const p = pax.get(m.id) ?? 0;
    if (!p) continue;
    const { hit, miss } = menuPreview(m, weekday, L);
    used.push({ id: m.id, name: m.name, pax: p, dishes: hit.length, missing: miss.length });
    for (const h of hit) {
      const d = dishes[h.r.code] || (dishes[h.r.code] = { r: h.r, pax: 0, meals: {}, from: {} });
      d.pax += p;
      d.meals[h.meal] = true;
      d.from[m.name] = (d.from[m.name] || 0) + p;
      reqExpand(h.r, p, req, res, 0);
    }
    for (const n of miss) missing[n] = (missing[n] || 0) + p;
  }
  return {
    rows: Object.values(res.acc).sort((a, b) => b.cost - a.cost),
    dishes: Object.values(dishes),
    missing,
    menus: used,
    people: used.reduce((a, m) => a + m.pax, 0),
    flags: res.flags,
  };
}

/** Weekday name of a YYYY-MM + DD (legacy pWeekday 2196: Saturday-first week). */
export function weekdayOf(month: string, day: string, days: readonly string[]): string {
  const [y, mo] = month.split('-').map(Number) as [number, number];
  return days[(new Date(y, mo - 1, Number(day)).getDay() + 1) % 7]!;
}
