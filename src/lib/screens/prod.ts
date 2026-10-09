import { cost, type CostRecipe } from '@/domain/costing';
import { lookupFor, menuDemand, menuPreview, weekdayOf, type PlanLookup } from '@/domain/menu-plans';
import {
  byCostDesc,
  byQtyDesc,
  dayTotals,
  daysIn,
  pad2,
  ProdIndex,
  reqForDay,
  type ProdCard,
} from '@/domain/production/day';
import { reconcile, type ReqContext, type ReqEntry, type ReqFlag } from '@/domain/production/requisition';
import { MENU_DAYS, PLAN_ALIAS, SECTIONS, sectionOf } from '@/data';
import type { Catalog } from '../db/catalog';
import { canSeeBrand } from '../db/scope';
import type { PageCtx } from '../page';
import { loadMenus, loadPax, loadProduction, type MenuRecord } from '../services/planning';
import type { Queryable } from '../db/client';

export type ProdView = 'day' | 'req' | 'month';

export interface ProdParams {
  view: ProdView;
  month: string;
  day: string;
  /** '*' or a brand id */
  brand: string;
  /** '*' or a site name ('' never appears in the URL) */
  loc: string;
}

export interface ReqRow {
  code: string;
  name: string;
  uom: string;
  qty: number;
  purchaseQty: number;
  cost: number;
  from: Record<string, number>;
}

const row = (e: ReqEntry): ReqRow => ({
  code: e.code,
  name: e.name,
  uom: e.uom,
  qty: e.qty,
  purchaseQty: e.purchaseQty,
  cost: e.cost,
  from: e.from,
});

export interface DayCardRow {
  code: string;
  name: string;
  brandCode: string;
  food: number;
  qty: number;
  value: number;
}
export interface DaySection {
  key: string;
  en: string;
  ar: string;
  cards: DayCardRow[];
  total: number;
}

export interface ReqSection {
  key: string;
  en: string;
  ar: string;
  recipes: { code: string; name: string; brandCode: string; portions: number; rows: ReqRow[] }[];
}

export interface Reconciliation {
  code: string;
  name: string;
  portions: number;
  requisitionValue: number;
  cardValueExBuffer: number;
  variance: number;
  bufferAllowance: number;
  matches: boolean;
  nFlags: number;
}

export interface BuilderData {
  weekday: string;
  /** the site the headcounts are saved under ('' = none) */
  site: string;
  hasSites: boolean;
  menus: { id: string; name: string; dishes: number; own: number; total: number }[];
  people: number;
  dishes: { name: string; q: number; from: Record<string, number> }[];
  estimate: number;
  missing: string[];
}

export interface ProdData {
  params: ProdParams;
  nd: number;
  locs: string[];
  brandOptions: { id: string; name: string }[];
  brandName: string;
  nCards: number;
  currency: string;
  weekday: string;
  /** day view */
  sections: DaySection[];
  totals: { total: number; portions: number; secCount: number };
  builder: BuilderData | null;
  draw: { rows: ReqRow[]; value: number };
  /** requisition view */
  req: {
    rows: ReqRow[];
    total: number;
    dishes: number;
    nSections: number;
    sections: ReqSection[];
    flags: ReqFlag[];
    reconciliation: Reconciliation[];
  };
  /** month view */
  monthRows: { day: string; portions: number; sec: Record<string, number>; total: number }[];
  monthTotals: { sec: Record<string, number>; portions: number; total: number };
  secLabels: { key: string; en: string; ar: string }[];
}

/** Everything the Production screen shows (Daily / Store requisition / Monthly), computed once on the server. */
export async function loadProd(db: Queryable, ctx: PageCtx, catalog: Catalog, p: ProdParams): Promise<ProdData> {
  const brandById = new Map(ctx.brands.map((b) => [b.id, b]));
  const inScope = (code: string) => {
    const m = catalog.cards[code];
    return m ? canSeeBrand(ctx.scope, m.brandId) : false;
  };
  const visibleRecipes: CostRecipe[] = [...catalog.context.recipes.values()].filter((r) => inScope(r.code));
  const brandHasCards = new Set(visibleRecipes.map((r) => catalog.cards[r.code]!.brandId));
  const brandOptions = ctx.brands.filter((b) => brandHasCards.has(b.id)).map((b) => ({ id: b.id, name: b.name }));

  // pLocs(): the brand's sites, or the union across brands when every brand is shown
  const locs =
    p.brand !== '*' ? (brandById.get(p.brand)?.locations ?? []) : [...new Set(ctx.brands.flatMap((b) => b.locations))];

  // pCards(): non-sub cards of the chosen brand(s)
  const cards: ProdCard[] = visibleRecipes
    .filter((r) => r.type !== 'sub' && (p.brand === '*' || catalog.cards[r.code]!.brandId === p.brand))
    .map((r) => ({
      recipe: r,
      food: cost(r, catalog.context).food || 0,
      section: sectionOf(catalog.cards[r.code]!.category),
      brandId: catalog.cards[r.code]!.brandId,
    }));
  const brandCode = (c: ProdCard) => brandById.get(c.brandId)?.code ?? '';

  const entries = await loadProduction(db, ctx.scope, p.month);
  const idx = new ProdIndex(
    entries.map((e) => ({ day: e.day, location: e.location, code: e.code, portions: e.portions })),
  );
  const nd = daysIn(p.month);
  const reqCtx: ReqContext = { items: catalog.context.items, recipes: visibleRecipes, conv: catalog.context.conv };
  const secLabels = SECTIONS.map((s) => ({ key: s[0], en: s[1], ar: s[2] }));
  const currency = catalog.settings.currency;
  const weekday = weekdayOf(p.month, p.day, MENU_DAYS);

  const t = dayTotals(cards, idx, p.day, p.loc);
  const sections: DaySection[] = SECTIONS.map((s) => {
    const list = cards
      .filter((c) => c.section === s[0])
      .sort((a, b) => (a.recipe.name || '').localeCompare(b.recipe.name || ''));
    return {
      key: s[0],
      en: s[1],
      ar: s[2],
      total: t.sec[s[0]] || 0,
      cards: list.map((c) => {
        const q = idx.qty(p.day, c.recipe.code, p.loc);
        return {
          code: c.recipe.code,
          name: c.recipe.name,
          brandCode: brandCode(c),
          food: c.food,
          qty: q,
          value: q * c.food,
        };
      }),
    };
  }).filter((s) => s.cards.length);

  const dayReq = reqForDay(cards, idx, p.day, p.loc, reqCtx);
  const allRows = Object.values(dayReq.all);
  const drawRows = [...allRows].sort(byQtyDesc).map(row);
  const consolidated = [...allRows].sort(byCostDesc).map(row);

  const reqSections: ReqSection[] = SECTIONS.map((s) => ({
    key: s[0],
    en: s[1],
    ar: s[2],
    recipes: (dayReq.bySec[s[0]] ?? []).map((x) => ({
      code: x.card.recipe.code,
      name: x.card.recipe.name,
      brandCode: brandCode(x.card),
      portions: x.portions,
      rows: Object.values(x.per).sort(byCostDesc).map(row),
    })),
  })).filter((s) => s.recipes.length);

  const withPortions = cards.map((c) => ({ c, q: idx.qty(p.day, c.recipe.code, p.loc) })).filter((x) => x.q > 0);
  const reconciliation =
    p.view === 'req'
      ? reconcile(
          withPortions.map((x) => ({ recipe: x.c.recipe, portions: x.q })),
          reqCtx,
          catalog.context.settings,
        ).map((r) => ({
          code: r.code,
          name: r.name,
          portions: r.portions,
          requisitionValue: r.requisitionValue,
          cardValueExBuffer: r.cardValueExBuffer,
          variance: r.variance,
          bufferAllowance: r.bufferAllowance,
          matches: r.matches,
          nFlags: r.flags.length,
        }))
      : [];

  // monthly
  const monthRows: ProdData['monthRows'] = [];
  const monthSec: Record<string, number> = {};
  let monthPortions = 0,
    monthTotal = 0;
  if (p.view === 'month') {
    for (let i = 1; i <= nd; i++) {
      const day = pad2(i);
      const dt = dayTotals(cards, idx, day, p.loc);
      monthTotal += dt.total;
      monthPortions += dt.portions;
      for (const s of SECTIONS) monthSec[s[0]] = (monthSec[s[0]] || 0) + (dt.sec[s[0]] || 0);
      if (dt.portions) monthRows.push({ day, portions: dt.portions, sec: dt.sec, total: dt.total });
    }
  }

  // menu builder: only when the SSEM project is the chosen brand (legacy prodBrand === 'bssem')
  let builder: BuilderData | null = null;
  const ssem = ctx.brands.find((b) => b.legacyId === 'bssem');
  if (p.view === 'day' && ssem && p.brand === ssem.id && ctx.menusVisible) {
    const menus = await loadMenus(db);
    const L: PlanLookup = lookupFor(catalog.context, visibleRecipes, PLAN_ALIAS);
    const site = p.loc !== '*' && locs.length ? p.loc : '';
    const pax = await loadPax(db, p.month);
    const total = (menuId: string) =>
      pax
        .filter((x) => x.day === p.day && x.menuId === menuId && (p.loc === '*' || x.location === p.loc))
        .reduce((a, x) => a + x.people, 0);
    const own = (menuId: string) =>
      pax.find((x) => x.day === p.day && x.menuId === menuId && x.location === site)?.people ?? 0;
    const totalMap = new Map(menus.map((m) => [m.id, total(m.id)]));
    const dem = menuDemand(menus, totalMap, weekday, L);
    const dishes = Object.values(dem.tot).sort((a, b) => b.q - a.q);
    builder = {
      weekday,
      site,
      hasSites: locs.length > 0,
      menus: menus.map((m: MenuRecord) => ({
        id: m.id,
        name: m.name,
        dishes: menuPreview(m, weekday, L).hit.length,
        own: own(m.id),
        total: totalMap.get(m.id) ?? 0,
      })),
      people: menus.reduce((a, m) => a + (totalMap.get(m.id) ?? 0), 0),
      dishes: dishes.map((d) => ({ name: d.r.name, q: d.q, from: d.from })),
      estimate: dishes.reduce(
        (a, d) => a + d.q * (cards.find((c) => c.recipe.code === d.r.code)?.food ?? cost(d.r, catalog.context).food),
        0,
      ),
      missing: Object.keys(dem.miss),
    };
  }

  return {
    params: p,
    nd,
    locs,
    brandOptions,
    brandName: p.brand === '*' ? 'All brands' : (brandById.get(p.brand)?.name ?? ''),
    nCards: cards.length,
    currency,
    weekday,
    sections,
    totals: { total: t.total, portions: t.portions, secCount: Object.keys(t.sec).length },
    builder,
    draw: { rows: drawRows, value: drawRows.reduce((a, x) => a + x.cost, 0) },
    req: {
      rows: consolidated,
      total: consolidated.reduce((a, x) => a + x.cost, 0),
      dishes: Object.values(dayReq.bySec).reduce((a, x) => a + x.length, 0),
      nSections: Object.keys(dayReq.bySec).length,
      sections: reqSections,
      flags: dayReq.flags,
      reconciliation,
    },
    monthRows,
    monthTotals: { sec: monthSec, portions: monthPortions, total: monthTotal },
    secLabels,
  };
}
