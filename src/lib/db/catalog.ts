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

const NONFOOD = (category: string) => category.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() === 'nonfood';

/**
 * The part of the catalog that costing ONE card can read, in a single statement (instead of every ingredient and every
 * recipe line). The engine only ever does Map.get(code) for codes reachable from the card's lines (items, sub-recipes and
 * their lines, conversions by item code), so the transitive closure of the line codes costs the card identically. UNION
 * (not UNION ALL) lets a cycle terminate; the card itself is always included; lines stay in sort_order (float summation
 * order); live cards only. Also returns the card's packaging lines (main category Nonfood) and the cost settings.
 * `cards` is empty: it is only used by list screens, never by costing.
 */
export async function loadCostClosure(
  db: Queryable,
  lineCodes: string[],
  selfId: string,
): Promise<{ catalog: Catalog; packaging: string[] }> {
  const { rows } = await db.query(
    `WITH RECURSIVE walk(code) AS (
       SELECT DISTINCT c FROM unnest($1::text[]) AS c WHERE c <> ''
       UNION
       SELECT l.code FROM walk w
         JOIN recipe r ON r.code = w.code AND r.deleted_at IS NULL
         JOIN recipe_line l ON l.recipe_id = r.id
        WHERE l.code <> ''
     )
     SELECT
       (SELECT coalesce(json_agg(json_build_object('code', i.code, 'name', i.name, 'uom', i.uom, 'price', i.price,
                                                   'category', i.category, 'recipeUnit', c.recipe_unit, 'factor', c.factor)
                                 ORDER BY i.code), '[]'::json)
          FROM ingredient i LEFT JOIN unit_conversion c ON c.ingredient_id = i.id
         WHERE i.code IN (SELECT code FROM walk)) AS items,
       (SELECT coalesce(json_agg(json_build_object(
                  'id', r.id, 'code', r.code, 'name', r.name, 'type', r.type, 'output', r.output, 'subQty', r.sub_qty,
                  'subUom', r.sub_uom, 'batchOut', r.batch_out, 'batchUom', r.batch_uom, 'price', r.selling_price,
                  'buffer', r.buffer,
                  'lines', (SELECT coalesce(json_agg(json_build_object('code', l.code, 'qty', l.qty, 'unit', l.unit,
                                                                       'y', l.y, 'yp', l.yp) ORDER BY l.sort_order), '[]'::json)
                              FROM recipe_line l WHERE l.recipe_id = r.id)) ORDER BY r.code), '[]'::json)
          FROM recipe r
         WHERE r.deleted_at IS NULL AND (r.code IN (SELECT code FROM walk) OR r.id = $2)) AS recipes,
       (SELECT json_build_object('currency', s.currency, 'pkg', s.pkg, 'del', s.del, 'lab', s.lab, 'ops', s.ops,
                                 'buffer', s.buffer, 'target', s.target, 'vat', s.vat,
                                 'priceDate', to_char(s.price_date, 'YYYY-MM-DD'), 'version', s.version)
          FROM cost_settings s WHERE s.id = 1) AS settings`,
    [lineCodes, selfId],
  );
  const row = rows[0];
  if (!row?.settings) throw new Error('cost_settings row is missing (database not seeded)');

  type ItemRow = {
    code: string;
    name: string;
    uom: string;
    price: number | null;
    category: string;
    recipeUnit: string | null;
    factor: number | null;
  };
  const itemRows = row.items as ItemRow[];
  const items: CostItem[] = [];
  const conv: [string, ConvEntry][] = [];
  for (const r of itemRows) {
    items.push({ code: r.code, name: r.name, uom: r.uom, price: r.price });
    if (r.recipeUnit !== null) conv.push([r.code, [r.recipeUnit, r.factor as number]]);
  }
  type RecRow = Omit<CostRecipe, 'type'> & { type: 'MENU' | 'SUB' };
  const recipes: CostRecipe[] = (row.recipes as RecRow[]).map((r) => ({
    ...r,
    type: r.type === 'SUB' ? 'sub' : 'menu',
  }));
  const settings = row.settings as CatalogData['settings'];
  const wanted = new Set(lineCodes);
  return {
    catalog: buildCatalog({ items, conv, recipes, cards: {}, settings }),
    packaging: itemRows.filter((r) => wanted.has(r.code) && NONFOOD(r.category)).map((r) => r.code),
  };
}
