import {
  buildContext,
  type ConvEntry,
  type CostContext,
  type CostItem,
  type CostRecipe,
  type CostSettings,
} from '@/domain/costing';
import type { Queryable } from './client';

/** Plain, JSON-serialisable catalog rows (what the cache stores; no Maps, no Dates). */
export interface CatalogData {
  items: CostItem[];
  conv: [string, ConvEntry][];
  recipes: CostRecipe[];
  /** card code -> facts the engine does not need but callers filter on. */
  cards: Record<string, { id: string; brandId: string; status: 'DRAFT' | 'LOCKED'; category: string }>;
  settings: CostSettings & { currency: string; priceDate: string; version: number };
}

export interface Catalog {
  context: CostContext;
  cards: CatalogData['cards'];
  settings: CatalogData['settings'];
}

/**
 * Unscoped catalog for the costing engine (D-40): 3 queries, no photos, no per-row round trips.
 * Costing crosses brands (a sub-recipe or a Shared item may live anywhere), so the caller filters by
 * BrandScope AFTER costing. Never expose this object directly. float8 columns reach the engine untouched.
 */
export async function loadCatalogData(db: Queryable): Promise<CatalogData> {
  // sequential: a Queryable may be one pg Client (a transaction), which must not run concurrent queries
  const ing = await db.query(
    `SELECT i.code, i.name, i.uom, i.price, c.recipe_unit, c.factor
       FROM ingredient i LEFT JOIN unit_conversion c ON c.ingredient_id = i.id ORDER BY i.code`,
  );
  const rec = await db.query(
    `SELECT r.id AS rid, r.code, r.name, r.type, r.brand_id, r.status, r.category, r.output, r.sub_qty, r.sub_uom,
              r.batch_out, r.batch_uom, r.selling_price, r.buffer,
              l.code AS lcode, l.qty, l.unit, l.y, l.yp
       FROM recipe r LEFT JOIN recipe_line l ON l.recipe_id = r.id
       WHERE r.deleted_at IS NULL
       ORDER BY r.code, l.sort_order`,
  );
  const set = await db.query(
    `SELECT currency, pkg, del, lab, ops, buffer, target, vat, to_char(price_date, 'YYYY-MM-DD') AS price_date, version
       FROM cost_settings WHERE id = 1`,
  );
  const s = set.rows[0];
  if (!s) throw new Error('cost_settings row is missing (database not seeded)');

  const items: CostItem[] = [];
  const conv: [string, ConvEntry][] = [];
  for (const r of ing.rows) {
    items.push({ code: r.code, name: r.name, uom: r.uom, price: r.price });
    if (r.recipe_unit !== null) conv.push([r.code, [r.recipe_unit, r.factor]]);
  }

  const recipes: CostRecipe[] = [];
  const cards: CatalogData['cards'] = {};
  const byId = new Map<string, CostRecipe>();
  for (const r of rec.rows) {
    let card = byId.get(r.rid);
    if (!card) {
      card = {
        id: r.rid,
        code: r.code,
        name: r.name,
        type: r.type === 'SUB' ? 'sub' : 'menu',
        output: r.output,
        subQty: r.sub_qty,
        subUom: r.sub_uom,
        batchOut: r.batch_out,
        batchUom: r.batch_uom,
        price: r.selling_price,
        buffer: r.buffer,
        lines: [],
      };
      byId.set(r.rid, card);
      recipes.push(card);
      cards[r.code] = { id: r.rid, brandId: r.brand_id, status: r.status, category: r.category };
    }
    if (r.lcode !== null) card.lines.push({ code: r.lcode, qty: r.qty, unit: r.unit, y: r.y, yp: r.yp });
  }

  return {
    items,
    conv,
    recipes,
    cards,
    settings: {
      pkg: s.pkg,
      del: s.del,
      lab: s.lab,
      ops: s.ops,
      buffer: s.buffer,
      target: s.target,
      vat: s.vat,
      currency: s.currency,
      priceDate: s.price_date,
      version: s.version,
    },
  };
}

export function buildCatalog(data: CatalogData): Catalog {
  return {
    context: buildContext(data.items, data.recipes, data.conv, data.settings),
    cards: data.cards,
    settings: data.settings,
  };
}

export async function loadCatalog(db: Queryable): Promise<Catalog> {
  return buildCatalog(await loadCatalogData(db));
}
