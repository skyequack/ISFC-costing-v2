import type { CostRecipe } from '@/domain/costing';
import {
  lookupFor,
  planCost,
  planDay,
  planFamily,
  planWeek,
  prepDemand,
  menuPreview,
  weekdayOf,
  type PlanLookup,
  type PrepResult,
} from '@/domain/menu-plans';
import type { ReqContext } from '@/domain/production/requisition';
import { MENU_DAYS, PLAN_ALIAS } from '@/data';
import type { Catalog } from '../db/catalog';
import type { Queryable } from '../db/client';
import { canSeeBrand } from '../db/scope';
import type { PageCtx } from '../page';
import { loadMenus, loadPax, type MenuRecord } from '../services/planning';

export interface PlanCellDto {
  label: string;
  kind: 'ITEM' | 'RECIPE' | 'NONE';
  code: string | null;
  v: number | null;
  src: string;
  /** an unpriced ITEM cell whose ingredient exists: the plan lets you price it in place (legacy setMenuPrice) */
  editable: boolean;
}
export interface PlanMenuDto {
  id: string;
  name: string;
  family: string;
  days: string[];
  version: number;
  active: boolean;
  rows: { meal: string; cells: Record<string, PlanCellDto | null> }[];
  dayTot: Record<string, { tot: number; priced: number; unp: number }>;
  week: number;
  unpriced: number;
}

export interface PlanData {
  menus: PlanMenuDto[];
  currency: string;
}

function visibleRecipes(catalog: Catalog, ctx: PageCtx): CostRecipe[] {
  return [...catalog.context.recipes.values()].filter((r) => {
    const m = catalog.cards[r.code];
    return m !== undefined && canSeeBrand(ctx.scope, m.brandId);
  });
}

export async function loadPlan(db: Queryable, ctx: PageCtx, catalog: Catalog): Promise<PlanData> {
  const menus = await loadMenus(db, true);
  const L = lookupFor(catalog.context, visibleRecipes(catalog, ctx), PLAN_ALIAS);
  return { currency: catalog.settings.currency, menus: menus.map((m) => planMenuDto(m, L)) };
}

export function planMenuDto(m: MenuRecord, L: PlanLookup): PlanMenuDto {
  const rows = m.rows.map((r) => ({
    meal: r.meal,
    cells: Object.fromEntries(
      Object.entries(r.cells).map(([d, c]) => {
        if (!c) return [d, null];
        const q = planCost(c, L);
        const bad = q.v == null || q.v === 0;
        return [
          d,
          {
            label: c.label,
            kind: c.kind,
            code: c.code,
            v: q.v,
            src: q.src,
            editable: bad && c.kind === 'ITEM' && !!c.code && L.ctx.items.has(c.code),
          },
        ];
      }),
    ) as Record<string, PlanCellDto | null>,
  }));
  const dayTot = Object.fromEntries(m.days.map((d) => [d, planDay(m, d, L)]));
  return {
    id: m.id,
    name: m.name,
    family: planFamily(m.name),
    days: m.days,
    version: m.version,
    active: m.active,
    rows,
    dayTot,
    week: planWeek(m, L),
    unpriced: m.days.reduce((a, d) => a + (dayTot[d]?.unp ?? 0), 0),
  };
}

// ------------------------------------------------------------------------------ preparation

export interface PrepParams {
  month: string;
  day: string;
  /** '*' or a site */
  loc: string;
  weekday: string;
}
export interface PrepData {
  params: PrepParams;
  locs: string[];
  menusVisible: boolean;
  menus: { id: string; name: string; own: number; total: number; dishes: number; missing: number }[];
  result: {
    people: number;
    dishes: { code: string; name: string; from: string[]; pax: number }[];
    rows: { code: string; name: string; uom: string; qty: number; cost: number; wantedBy: string[] }[];
    missing: string[];
    menus: PrepResult['menus'];
    totalCost: number;
  };
}

export async function loadPrep(db: Queryable, ctx: PageCtx, catalog: Catalog, p: PrepParams): Promise<PrepData> {
  const ssem = ctx.brands.find((b) => b.legacyId === 'bssem');
  const locs = ssem?.locations ?? [];
  const empty: PrepData['result'] = { people: 0, dishes: [], rows: [], missing: [], menus: [], totalCost: 0 };
  if (!ctx.menusVisible) return { params: p, locs, menusVisible: false, menus: [], result: empty };

  const menus = await loadMenus(db);
  const recipes = visibleRecipes(catalog, ctx);
  const L = lookupFor(catalog.context, recipes, PLAN_ALIAS);
  const reqCtx: ReqContext = { items: catalog.context.items, recipes, conv: catalog.context.conv };
  const pax = await loadPax(db, p.month);
  const site = p.loc === '*' ? '' : p.loc;
  const rowsOf = (menuId: string) => pax.filter((x) => x.day === p.day && x.menuId === menuId);
  const total = (menuId: string) =>
    rowsOf(menuId)
      .filter((x) => p.loc === '*' || x.location === p.loc)
      .reduce((a, x) => a + x.people, 0);
  const own = (menuId: string) => rowsOf(menuId).find((x) => x.location === site)?.people ?? 0;
  const paxMap = new Map(menus.map((m) => [m.id, total(m.id)]));
  const D = prepDemand(menus, paxMap, p.weekday, L, reqCtx);
  return {
    params: p,
    locs,
    menusVisible: true,
    menus: menus.map((m) => {
      const pv = menuPreview(m, p.weekday, L);
      return {
        id: m.id,
        name: m.name,
        own: own(m.id),
        total: paxMap.get(m.id) ?? 0,
        dishes: pv.hit.length,
        missing: pv.miss.length,
      };
    }),
    result: {
      people: D.people,
      dishes: [...D.dishes]
        .sort((a, b) => b.pax - a.pax)
        .map((d) => ({ code: d.r.code, name: d.r.name, from: Object.keys(d.from), pax: d.pax })),
      rows: D.rows.map((x) => ({
        code: x.code,
        name: x.name,
        uom: x.uom,
        qty: x.qty,
        cost: x.cost,
        wantedBy: Object.keys(x.from || {}),
      })),
      missing: Object.keys(D.missing),
      menus: D.menus,
      totalCost: D.rows.reduce((n, x) => n + x.cost, 0),
    },
  };
}

export const defaultWeekday = (month: string, day: string) => weekdayOf(month, day, MENU_DAYS);
