import { costWithIssues, lineCost, num, type CostRecipe, type CostWithIssues, type LineCost } from '@/domain/costing';
import type { Catalog } from '../db/catalog';
import type { RecipeDto } from '../db/repo/recipes';

export interface LineView {
  name: string;
  uom: string;
  price: number;
  kind: LineCost['kind'];
  err: string;
  needConv: boolean;
  qty: number;
  y: number;
  cost: number;
}

/** What the editor / locked view / print need beyond the stored card: the legacy cost result and per-line costs. */
export interface CardView {
  cost: CostWithIssues;
  lines: LineView[];
  sumQty: number;
}

export function toCostRecipe(r: Pick<RecipeDto, 'id' | 'code' | 'name' | 'type' | 'output' | 'subQty' | 'subUom' | 'batchOut' | 'batchUom' | 'sellingPrice' | 'buffer' | 'lines'>): CostRecipe {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    type: r.type === 'SUB' ? 'sub' : 'menu',
    output: r.output,
    subQty: r.subQty,
    subUom: r.subUom,
    batchOut: r.batchOut,
    batchUom: r.batchUom,
    price: r.sellingPrice,
    buffer: r.buffer,
    lines: r.lines.map((l) => ({ code: l.code, qty: l.qty, unit: l.unit, y: l.y, yp: l.yp })),
  };
}

export function buildCardView(catalog: Catalog, rec: CostRecipe): CardView {
  const ctx = catalog.context;
  return {
    cost: costWithIssues(rec, ctx),
    lines: rec.lines.map((l) => {
      if (!l.code) return { name: '', uom: '', price: 0, kind: 'none', err: '', needConv: false, qty: num(l.qty), y: 1, cost: 0 };
      const c = lineCost(l, ctx);
      return { name: c.name, uom: c.uom, price: c.price, kind: c.kind, err: c.err, needConv: c.needConv, qty: c.qty, y: c.y, cost: c.cost };
    }),
    sumQty: rec.lines.reduce((a, l) => a + num(l.qty), 0),
  };
}
