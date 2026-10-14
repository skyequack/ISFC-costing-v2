import { asOf, neverLocked, periodKey, type CardHistory, type ItemHistory, type Revision } from '@/domain/asof';
import type { CostItem, CostRecipe } from '@/domain/costing';
import { buildCatalog, type Catalog, type CatalogData } from '../db/catalog';
import type { Queryable } from '../db/client';

/**
 * Costing by date (D-100, B3): the catalog as it was on a business day. The costing engine is unchanged; this only decides
 * which revision of every card and which price of every ingredient it is fed with. Menus, plans and the card screens never
 * use it (they cost the card as it is today).
 */
export interface AsOfCatalogs {
  /** false: nothing in the range has history, `catalogFor` always returns the current catalog and nothing was loaded */
  active: boolean;
  /** the catalog of one day (YYYY-MM-DD); days that cost alike share one catalog */
  catalogFor(date: string): Catalog;
  /** false for a card with no approved revision at all: production costs it as the card is today and flags it */
  isApproved(code: string): boolean;
}

/** The plain rows a Catalog was built from (Maps keep insertion order, so the round trip is exact). */
function dataOf(c: Catalog): CatalogData {
  return {
    items: [...c.context.items.values()],
    conv: [...c.context.conv.entries()],
    recipes: [...c.context.recipes.values()],
    cards: c.cards,
    settings: c.settings,
  };
}

const NONE: (catalog: Catalog) => AsOfCatalogs = (catalog) => ({
  active: false,
  catalogFor: () => catalog,
  isApproved: (code) => catalog.cards[code]?.status === 'LOCKED',
});

/**
 * Loads what is needed to cost days from `start` on. One cheap statement says whether anything differs from today; only then
 * are the archived revisions and the price history read (three more statements, restricted to cards with a history and
 * ingredients whose price changed after `start`).
 */
export async function loadAsOf(db: Queryable, catalog: Catalog, start: string): Promise<AsOfCatalogs> {
  const need = await db.query(
    `SELECT (EXISTS (SELECT 1 FROM recipe r WHERE r.deleted_at IS NULL AND r.revision > 1
                      AND (r.effective_from > $1::date OR r.status = 'DRAFT'))
             OR EXISTS (SELECT 1 FROM ingredient_price_history WHERE effective_on > $1::date)) AS yes`,
    [start],
  );
  if (!need.rows[0]!.yes) return NONE(catalog);

  const live = catalog.context.recipes;
  const versions = await db.query(
    `SELECT v.id, r.code, r.effective_from::text AS live_from, r.status AS live_status, v.effective_from::text AS v_from,
            v.status, v.name, v.type, v.output, v.sub_qty, v.sub_uom, v.batch_out, v.batch_uom, v.selling_price, v.buffer
       FROM recipe r JOIN recipe_version v ON v.recipe_id = r.id
      WHERE r.deleted_at IS NULL ORDER BY r.code, v.revision`,
  );
  const lines = await db.query(
    `SELECT l.version_id, l.code, l.qty, l.unit, l.y, l.yp
       FROM recipe_version_line l JOIN recipe_version v ON v.id = l.version_id JOIN recipe r ON r.id = v.recipe_id AND r.deleted_at IS NULL
      ORDER BY l.version_id, l.sort_order`,
  );
  const linesOf = new Map<string, CostRecipe['lines']>();
  for (const l of lines.rows) {
    const list = linesOf.get(l.version_id as string) ?? [];
    list.push({ code: l.code, qty: l.qty, unit: l.unit, y: l.y, yp: l.yp });
    linesOf.set(l.version_id as string, list);
  }
  const cards = new Map<string, CardHistory>();
  for (const v of versions.rows) {
    const liveRec = live.get(v.code as string);
    if (!liveRec) continue; // a live card the catalog does not know (cache older than the card): costed as today
    let h = cards.get(v.code as string);
    if (!h) {
      h = { code: v.code, liveFrom: v.live_from, liveStatus: v.live_status, archived: [] };
      cards.set(v.code as string, h);
    }
    h.archived.push({
      from: v.v_from,
      status: v.status,
      recipe: {
        id: liveRec.id,
        code: v.code,
        name: v.name,
        type: v.type === 'SUB' ? 'sub' : 'menu',
        output: v.output,
        subQty: v.sub_qty,
        subUom: v.sub_uom,
        batchOut: v.batch_out,
        batchUom: v.batch_uom,
        price: v.selling_price,
        buffer: v.buffer,
        lines: linesOf.get(v.id as string) ?? [],
      },
    } satisfies Revision);
  }
  const prices = await db.query(
    `SELECT i.code, h.effective_on::text AS on_day, h.old_price, h.new_price
       FROM ingredient_price_history h JOIN ingredient i ON i.id = h.ingredient_id
      WHERE h.ingredient_id IN (SELECT ingredient_id FROM ingredient_price_history WHERE effective_on > $1::date)
      ORDER BY h.ingredient_id, h.effective_on, h.created_at, h.id`,
    [start],
  );
  const items = new Map<string, ItemHistory>();
  for (const p of prices.rows) {
    let h = items.get(p.code as string);
    if (!h) {
      h = { code: p.code, points: [] };
      items.set(p.code as string, h);
    }
    h.points.push({ on: p.on_day, oldPrice: p.old_price, newPrice: p.new_price });
  }

  const cardList = [...cards.values()];
  const itemList = [...items.values()];
  const base = dataOf(catalog);
  const built = new Map<string, Catalog>();
  return {
    active: true,
    catalogFor(date) {
      const key = periodKey(cardList, itemList, date);
      let c = built.get(key);
      if (!c) {
        const day = asOf({ items: base.items as CostItem[], recipes: base.recipes }, cardList, itemList, date);
        c = buildCatalog({ ...base, items: day.items, recipes: day.recipes });
        built.set(key, c);
      }
      return c;
    },
    isApproved(code) {
      const h = cards.get(code);
      if (!h) return catalog.cards[code]?.status === 'LOCKED';
      const revs: Pick<Revision, 'status'>[] = [...h.archived, { status: h.liveStatus }];
      return !neverLocked(revs as Revision[]);
    },
  };
}
