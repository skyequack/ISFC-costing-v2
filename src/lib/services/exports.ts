import { z } from 'zod';
import { cost, lineCost } from '@/domain/costing';
import { dayTotals, daysIn, pad2, ProdIndex, type ProdCard } from '@/domain/production/day';
import { sectionOf, SECTIONS } from '@/data';
import { pctText } from '@/domain/recipes/yield-stages';
import { RTPL_HEAD } from '../import/recipes';
import { ITEM_UNIT_HEAD, ITEM_YIELD_HEAD } from '../import/items';
import { STOCK_TPL_HEAD } from '../import/stock';
import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { loadCatalog } from '../db/catalog';
import { listIngredients } from '../db/repo/ingredients';
import { visibleSites } from '../db/repo/stock';
import { canSeeBrand } from '../db/scope';
import { ApiError } from '../errors';
import { can } from '../permissions';
import { planCost, planDay, planWeek, lookupFor, planFamily } from '@/domain/menu-plans';
import { PLAN_ALIAS } from '@/data';
import { buildCtx, type PageCtx } from '../screens/ctx';
import { loadPrep } from '../screens/plan';
import { loadProd } from '../screens/prod';
import { auditExport } from './audit';
import { resolveClientChoice } from './clients';
import { loadMenus, loadProduction } from './planning';
import { loadAsOf } from './asof';
import { dashExportRows } from './dash-export';
import { stockDate } from './stock';

export const EXPORT_KINDS = [
  'recipes',
  'recipe-lines',
  'ingredients',
  'requisition',
  'production',
  'prep',
  'plan',
  'recipes-data',
  'price-template',
  'dash',
  'stock-counts-template',
  'stock-receipts-template',
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const exportQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  day: z
    .string()
    .regex(/^(0[1-9]|[12]\d|3[01])$/)
    .optional(),
  brand: z.string().max(64).default('*'),
  loc: z.string().max(40).default('*'),
  /** '*' = every client, 'none' = unassigned, or a client id (D-71) */
  client: z.string().max(64).default('*'),
  wd: z.string().max(12).optional(),
  menuId: z.string().max(64).optional(),
  /** dashboard range, day-level inclusive (D-65) */
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  /** recipes-data only (D-98): export ONE card, by its id, in the same re-uploadable layout */
  card: z.string().max(64).optional(),
  /** day of a stock template, YYYY-MM-DD (D-86) */
  date: z.string().max(10).optional(),
});
export type ExportQuery = z.output<typeof exportQuery>;

export interface ExportFile {
  filename: string;
  rows: unknown[][];
  /** data rows for the audit entry when the file is not one header + data (multi-section sheets) */
  dataRows?: number;
}

const f = (v: number, d: number) => v.toFixed(d);
/** D-93: a raw material's default yields as percent cells (blank = none = 100%). */
/** D-102: purchase and inventory unit with the base units in one of each (the base unit and 1 when never set). */
const itemUnitCells = (i: {
  uom: string;
  purchaseUnit?: string;
  purchaseFactor?: number;
  inventoryUnit?: string;
  inventoryFactor?: number;
}): string[] => [
  i.purchaseUnit ?? i.uom,
  String(i.purchaseFactor ?? 1),
  i.inventoryUnit ?? i.uom,
  String(i.inventoryFactor ?? 1),
];
const itemYieldCells = (i: { yThaw?: number | null; yCut?: number | null; yCook?: number | null }): string[] =>
  [i.yThaw, i.yCut, i.yCook].map(pctText);

/**
 * The sheet staff fill in for the Stock upload (D-73, D-86): one row per ingredient in the caller's scope, Quantity left empty.
 * Needs stock.edit as well as export; `loc` must be one of the caller's sites (404 otherwise), `date` a calendar day.
 */
async function stockTemplate(
  db: Queryable,
  user: SessionUser,
  ctx: PageCtx,
  kind: 'stock-counts-template' | 'stock-receipts-template',
  q: ExportQuery,
): Promise<ExportFile> {
  if (!can(user.role, 'stock.edit')) throw new ApiError('forbidden', 'Your role cannot do that');
  const date = stockDate.safeParse(q.date);
  if (!date.success) throw new ApiError('bad_request', 'date must be YYYY-MM-DD');
  if (!(await visibleSites(db, ctx.scope)).includes(q.loc)) throw new ApiError('not_found', 'Not found');
  const items = await listIngredients(db, ctx.scope, true); // D-104: the Unit column is the inventory unit
  const noun = kind === 'stock-counts-template' ? 'counts' : 'receipts';
  return {
    filename: `ISFC-stock-${noun}-${q.loc.replace(/[^\w.-]+/g, '-')}-${date.data}.csv`,
    rows: [STOCK_TPL_HEAD, ...items.map((i) => [q.loc, date.data, i.code, i.name, i.inventoryUnit ?? i.uom, ''])],
  };
}

/** Build one export (data only). Permission `export`; brand scope applies to every kind (D-07). Auditing is done by exportAndAudit. */
export async function buildExport(
  db: Queryable,
  user: SessionUser,
  kind: ExportKind,
  q: ExportQuery,
  ctxIn?: PageCtx,
): Promise<ExportFile> {
  if (!can(user.role, 'export')) throw new ApiError('forbidden', 'Your role cannot do that');
  const ctx = ctxIn ?? (await buildCtx(db, user));
  if (kind === 'stock-counts-template' || kind === 'stock-receipts-template')
    return stockTemplate(db, user, ctx, kind, q); // needs no catalog
  const catalog = await loadCatalog(db);
  if (kind === 'dash') return dashExportRows(db, ctx, catalog, q); // needs neither the lock info nor the maps below
  const brandName = new Map(ctx.brands.map((b) => [b.id, b.name]));
  const brandCode = new Map(ctx.brands.map((b) => [b.id, b.code]));
  const live = [...catalog.context.recipes.values()].filter((r) => {
    const m = catalog.cards[r.code];
    return m && m.id === r.id && canSeeBrand(ctx.scope, m.brandId);
  });
  const meta = await db.query('SELECT code, locked_by, locked_at FROM recipe WHERE deleted_at IS NULL');
  const lockInfo = new Map(
    meta.rows.map((r) => [
      r.code as string,
      {
        by: (r.locked_by as string | null) ?? '',
        at: r.locked_at ? (r.locked_at as Date).toISOString().slice(0, 10) : '',
      },
    ]),
  );

  switch (kind) {
    case 'recipes': {
      const head = [
        'Code',
        'Name',
        'Brand',
        'Status',
        'Approved By',
        'Approved On',
        'Category',
        'Type',
        'Portions',
        'Batch Output',
        'Batch Output UOM',
        'Portion Size',
        'Batch Cost',
        'Original Cost',
        'Food Cost',
        'Packaging',
        'Delivery',
        'Labor',
        'OPS',
        'Total Cost',
        'Sales Price',
        'Food Cost %',
        'Total Cost %',
        'Net Profit',
        'Net %',
        'Price at Target',
        'Weight/Portion g',
        'Status',
      ];
      const rows = live.map((r) => {
        const c = cost(r, catalog.context);
        const m = catalog.cards[r.code]!;
        const lk = lockInfo.get(r.code) ?? { by: '', at: '' };
        return [
          r.code,
          r.name,
          brandName.get(m.brandId) ?? '',
          m.status === 'LOCKED' ? 'Locked' : 'Draft',
          lk.by,
          lk.at,
          m.category,
          r.type === 'sub' ? 'Sub-Recipe' : 'Menu Item',
          c.out,
          f(c.bOut, 2),
          c.bUom,
          f(c.portion, 2),
          f(c.batch, 4),
          f(c.orig, 4),
          f(c.food, 4),
          f(c.pkg, 4),
          f(c.del, 4),
          f(c.lab, 4),
          f(c.ops, 4),
          f(c.totalCost, 4),
          c.sp,
          c.fcPct == null ? '' : f(c.fcPct * 100, 2),
          c.tcPct == null ? '' : f(c.tcPct * 100, 2),
          f(c.net, 4),
          c.npPct == null ? '' : f(c.npPct * 100, 2),
          f(c.suggest, 4),
          f(c.weight, 1),
          c.err || 'OK',
        ];
      });
      return { filename: 'ISFC-recipe-costing.csv', rows: [head, ...rows] };
    }
    case 'recipe-lines': {
      const head = [
        'Recipe Code',
        'Recipe',
        'Brand',
        'Item Code',
        'Item',
        'Purchase UOM',
        'Unit Price',
        'Qty',
        'Recipe Unit',
        'Yield %',
        'Gross Qty',
        'Line Cost',
        'Note',
      ];
      const rows: unknown[][] = [];
      for (const r of live)
        for (const l of r.lines) {
          if (!l.code) continue;
          const c = lineCost(l, catalog.context);
          rows.push([
            r.code,
            r.name,
            brandName.get(catalog.cards[r.code]!.brandId) ?? '',
            l.code,
            c.name,
            c.uom,
            c.price,
            l.qty,
            l.unit,
            (c.y * 100).toFixed(0),
            f(c.gross, 4),
            f(c.cost, 4),
            c.needConv ? 'MISSING CONVERSION' : c.err || '',
          ]);
        }
      return { filename: 'ISFC-recipe-lines.csv', rows: [head, ...rows] };
    }
    case 'ingredients': {
      const items = await listIngredients(db, ctx.scope, true);
      const head = [
        'Code',
        'Item Name',
        'UOM',
        'Price',
        'Available To',
        'Main Category',
        'Sub Category',
        'Review Flag',
        ...ITEM_YIELD_HEAD,
        ...ITEM_UNIT_HEAD,
      ];
      const rows = items.map((i) => [
        i.code,
        i.name,
        i.uom,
        i.price == null ? '' : f(i.price, 6),
        i.brandIds.length ? i.brandIds.map((id) => brandCode.get(id) ?? '').join(' ') : 'Shared',
        i.category,
        i.subcategory,
        i.flag,
        ...itemYieldCells(i),
        ...itemUnitCells(i),
      ]);
      return { filename: 'ISFC-ingredients.csv', rows: [head, ...rows] };
    }
    case 'price-template': {
      // legacy dlTemplate('brand' | 'all'): the items to edit and upload back (Code, Item Name, UOM, Price, Main Category, Sub Category, + the three default yields, D-93)
      const items = await listIngredients(db, ctx.scope, true);
      const mine = q.brand === '*' ? items : items.filter((i) => !i.brandIds.length || i.brandIds.includes(q.brand));
      if (q.brand !== '*' && !ctx.brands.some((b) => b.id === q.brand)) throw new ApiError('not_found', 'Not found');
      const head = [
        'Code',
        'Item Name',
        'UOM',
        'Price',
        'Main Category',
        'Sub Category',
        ...ITEM_YIELD_HEAD,
        ...ITEM_UNIT_HEAD,
      ];
      const rows = mine.map((i) => [
        i.code,
        i.name,
        i.uom,
        i.price == null ? '' : f(i.price, 6),
        i.category,
        i.subcategory,
        ...itemYieldCells(i),
        ...itemUnitCells(i),
      ]);
      return {
        filename:
          q.brand === '*' ? 'ISFC-all-ingredients.csv' : `ISFC-${brandCode.get(q.brand) ?? 'brand'}-price-list.csv`,
        rows: [head, ...rows],
      };
    }
    case 'recipes-data': {
      // re-uploadable layout (D-17: + Waste % and Card Buffer). `brand` = '*' for every card the caller may see.
      // D-98: `card` = one card by id (already limited to the caller's brands in `live`; unknown or out of scope = 404)
      const one = q.card ? live.find((r) => r.id === q.card) : undefined;
      if (q.card && !one) throw new ApiError('not_found', 'Not found');
      const list = one
        ? [one]
        : q.brand === '*'
          ? live
          : live.filter((r) => catalog.cards[r.code]!.brandId === q.brand);
      if (!one && q.brand !== '*' && !ctx.brands.some((b) => b.id === q.brand))
        throw new ApiError('not_found', 'Not found');
      const only = one ? [one.code] : null; // restricts the three lookups below to that card
      const bufRows = await db.query(
        'SELECT code, buffer FROM recipe WHERE deleted_at IS NULL AND buffer IS NOT NULL AND ($1::text[] IS NULL OR code = ANY($1::text[]))',
        [only],
      );
      const buffers = new Map(bufRows.rows.map((r) => [r.code as string, r.buffer as number]));
      const methods = await db.query(
        `SELECT r.code, array_agg(s.text ORDER BY s.step_number) AS steps FROM recipe r JOIN recipe_method_step s ON s.recipe_id = r.id WHERE r.deleted_at IS NULL AND ($1::text[] IS NULL OR r.code = ANY($1::text[])) GROUP BY r.code`,
        [only],
      );
      const stepsOf = new Map(methods.rows.map((r) => [r.code as string, r.steps as string[]]));
      // three-stage yield (D-70, D-85): per card, one [thaw, cut, cook] triple per stored line, in line order
      const stageRows = await db.query(
        `SELECT r.code, json_agg(json_build_array(l.y_thaw, l.y_cut, l.y_cook) ORDER BY l.sort_order) AS st
           FROM recipe r JOIN recipe_line l ON l.recipe_id = r.id
          WHERE r.deleted_at IS NULL AND ($1::text[] IS NULL OR r.code = ANY($1::text[])) GROUP BY r.code
         HAVING bool_or(l.y_thaw IS NOT NULL OR l.y_cut IS NOT NULL OR l.y_cook IS NOT NULL)`,
        [only],
      );
      const stagesOf = new Map(stageRows.rows.map((r) => [r.code as string, r.st as (number | null)[][]]));
      const rows: unknown[][] = [];
      for (const r of list) {
        const stg = stagesOf.get(r.code);
        const lines = r.lines.map((l, k) => ({ l, st: stg?.[k] })).filter((x) => x.l.code);
        const steps = (stepsOf.get(r.code) ?? []).filter((s) => String(s).trim());
        const n = Math.max(lines.length, steps.length, 1);
        const bc = brandCode.get(catalog.cards[r.code]!.brandId) ?? '';
        const buf = buffers.get(r.code);
        for (let i = 0; i < n; i++) {
          const l = lines[i]?.l;
          const st = lines[i]?.st;
          const lc = l ? lineCost(l, catalog.context) : null;
          rows.push([
            i === 0 ? bc : '',
            i === 0 ? r.code : '',
            i === 0 ? r.name : '',
            i === 0 ? catalog.cards[r.code]!.category : '',
            i === 0 ? (r.type === 'sub' ? 'Sub' : 'Menu') : '',
            i === 0 ? String(r.output || 1) : '',
            i === 0 ? String(r.batchOut || '') : '',
            i === 0 ? r.batchUom || '' : '',
            i === 0 ? String(r.price || '') : '',
            l ? l.code : '',
            lc ? lc.name : '',
            l ? String(l.qty) : '',
            l ? l.unit || '' : '',
            l ? String(Math.round((Number(l.y) || 1) * 100)) : '',
            steps[i] || '',
            l && l.yp != null ? String(l.yp) : '',
            i === 0 && buf != null ? String(+(buf * 100).toFixed(4)) : '',
            pctText(st?.[0]),
            pctText(st?.[1]),
            pctText(st?.[2]),
          ]);
        }
      }
      const base = one
        ? `ISFC-${one.code.replace(/[^\w.-]+/g, '-')}-recipe`
        : q.brand === '*'
          ? 'ISFC-all-recipes'
          : `ISFC-${brandCode.get(q.brand) ?? 'brand'}-recipes`;
      return { filename: `${base}.xlsx`, rows: [RTPL_HEAD, ...rows] };
    }
    case 'requisition': {
      if (!q.month || !q.day) throw new ApiError('bad_request', 'month and day are required');
      const d = await loadProd(db, ctx, catalog, {
        view: 'req',
        month: q.month,
        day: q.day,
        brand: q.brand,
        loc: q.loc,
        client: await resolveClientChoice(db, ctx.scope, q.client),
      });
      const out: unknown[][] = [
        ['Store requisition', `${q.month}-${q.day}`, `Site: ${q.loc === '*' ? 'all' : q.loc}`],
        [],
        ['CONSOLIDATED'],
        ['Code', 'Raw material', 'UOM', 'Issue', 'Value'],
      ];
      for (const e of d.req.rows) out.push([e.code, e.name, e.uom, f(e.qty, 1), f(e.cost, 2)]);
      out.push(
        [],
        ['BY SECTION AND RECIPE'],
        ['Brand', 'Section', 'Recipe', 'Portions', 'Code', 'Raw material', 'UOM', 'Draw'],
      );
      for (const s of d.req.sections)
        for (const r of s.recipes)
          for (const e of r.rows) out.push([r.brandCode, s.en, r.name, r.portions, e.code, e.name, e.uom, f(e.qty, 1)]);
      return { filename: `requisition-${q.month}-${q.day}.csv`, rows: out };
    }
    case 'production': {
      // D-19: the intended columns (legacy threw). One row per site/dish/day, plus a DAY TOTAL row.
      if (!q.month) throw new ApiError('bad_request', 'month is required');
      const wantedClient = await resolveClientChoice(db, ctx.scope, q.client);
      const entries = (await loadProduction(db, ctx.scope, q.month)).filter(
        (e) => wantedClient === '*' || e.clientId === (wantedClient === 'none' ? '' : wantedClient),
      );
      const idx = new ProdIndex(
        entries.map((e) => ({ day: e.day, location: e.location, code: e.code, portions: e.portions })),
      );
      // D-100 (B3): every day is costed with the revision and prices in force that day; days that cost alike share one catalog
      const asof = await loadAsOf(db, catalog, `${q.month}-01`);
      const cardsMemo = new Map<unknown, ProdCard[]>();
      const cardsOf = (date: string): ProdCard[] => {
        const cat = asof.catalogFor(date);
        let cs = cardsMemo.get(cat);
        if (!cs) {
          cs = [...cat.context.recipes.values()]
            .filter((r) => {
              const m = catalog.cards[r.code];
              return m && m.id === r.id && canSeeBrand(ctx.scope, m.brandId);
            })
            .filter((r) => r.type !== 'sub' && (q.brand === '*' || catalog.cards[r.code]!.brandId === q.brand))
            .map((r) => ({
              recipe: r,
              food: cost(r, cat.context).food || 0,
              section: sectionOf(catalog.cards[r.code]!.category),
              brandId: catalog.cards[r.code]!.brandId,
            }));
          cardsMemo.set(cat, cs);
        }
        return cs;
      };
      const out: unknown[][] = [
        ['Month', 'Day', 'Site', 'Brand', 'Section', 'Dish', 'Code', 'Portions', 'Cost/portion', 'Cost'],
      ];
      for (let i = 1; i <= daysIn(q.month); i++) {
        const day = pad2(i);
        const cards = cardsOf(`${q.month}-${day}`);
        for (const c of cards)
          for (const [site, qty] of idx.bySite(day, c.recipe.code)) {
            if (q.loc !== '*' && site !== q.loc) continue;
            const sec = SECTIONS.find((x) => x[0] === c.section)!;
            out.push([
              q.month,
              day,
              site || '-',
              brandCode.get(c.brandId) ?? '',
              sec[1],
              c.recipe.name,
              c.recipe.code,
              qty,
              f(c.food, 4),
              f(qty * c.food, 2),
            ]);
          }
        const t = dayTotals(cards, idx, day, q.loc);
        if (t.portions) out.push([q.month, day, '', '', '', 'DAY TOTAL', '', t.portions, '', f(t.total, 2)]);
      }
      return { filename: `production-${q.month}.csv`, rows: out };
    }
    case 'prep': {
      if (!q.month || !q.day || !q.wd) throw new ApiError('bad_request', 'month, day and wd are required');
      const d = await loadPrep(db, ctx, catalog, { month: q.month, day: q.day, loc: q.loc, weekday: q.wd });
      const out: unknown[][] = [['Code', 'Raw material', 'Unit', 'Quantity', 'Wanted by', 'Cost']];
      for (const x of d.result.rows)
        out.push([x.code, x.name, x.uom || '', f(x.qty, 4), x.wantedBy.join(' | '), f(x.cost, 4)]);
      return { filename: 'store-requisition.csv', rows: out };
    }
    case 'plan': {
      if (!ctx.menusVisible) throw new ApiError('not_found', 'Not found');
      if (!q.menuId) throw new ApiError('bad_request', 'menuId is required');
      const menus = await loadMenus(db, true);
      const m = menus.find((x) => x.id === q.menuId);
      if (!m) throw new ApiError('not_found', 'Not found');
      const L = lookupFor(catalog.context, live, PLAN_ALIAS);
      const days = m.days;
      const out: unknown[][] = [['Category', 'Menu', 'Meal', ...days]];
      for (const r of m.rows) {
        out.push([planFamily(m.name), m.name, r.meal, ...days.map((dy) => r.cells[dy]?.label ?? '')]);
        out.push([
          '',
          '',
          'cost',
          ...days.map((dy) => {
            const c = r.cells[dy];
            if (!c) return '';
            const p = planCost(c, L);
            return p.v == null ? p.src : f(p.v, 4);
          }),
        ]);
      }
      out.push(['', '', 'TOTAL / PAX', ...days.map((dy) => f(planDay(m, dy, L).tot, 4))]);
      out.push(['', '', 'WEEK TOTAL', f(planWeek(m, L), 4)]);
      return { filename: `menu-${m.name.replace(/[^\w-]+/g, '-')}.csv`, rows: out };
    }
  }
}

/** Build + audit in the caller's transaction (D-44): one `Exported data` entry with kind and row count. */
export async function exportAndAudit(
  tx: Queryable,
  user: SessionUser,
  kind: ExportKind,
  q: ExportQuery,
): Promise<ExportFile> {
  const file = await buildExport(tx, user, kind, q);
  const body = file.dataRows ?? Math.max(0, file.rows.length - (kind === 'requisition' || kind === 'plan' ? 0 : 1));
  await auditExport(tx, user, kind, body);
  return file;
}
