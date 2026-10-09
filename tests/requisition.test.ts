import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cost, type CostItem, type CostLine, type CostRecipe } from '@/domain/costing';
import { newReqResult, reconcile, reqExpand, requisitionTotal, type ReqContext } from '@/domain/production';
import { goldenContext, goldenState } from './helpers/golden';

const src = fs.readFileSync(path.resolve(__dirname, '../legacy/app.html'), 'utf8');
const a = src.indexOf('function reqExpand(');
const b = src.indexOf('function reqForDay(');

/** Legacy reqExpand evaluated verbatim from the frozen oracle against golden data. */
function legacyExpand(r: CostRecipe, portions: number) {
  const ITEM: Record<string, CostItem> = {};
  goldenState.items.forEach((i) => (ITEM[i.code] = i));
  const S = { recipes: goldenState.recipes };
  const num = (v: unknown) => {
    const n = parseFloat(v as string);
    return isFinite(n) ? n : 0;
  };
  const fn = new Function('S', 'ITEM', 'num', `${src.slice(a, b)}; return reqExpand;`)(S, ITEM, num) as (
    r: CostRecipe,
    p: number,
    acc: Record<string, { qty: number; cost: number; from: Record<string, number> }>,
    d: number,
  ) => void;
  const acc: Record<string, { qty: number; cost: number; from: Record<string, number> }> = {};
  fn(r, portions, acc, 0);
  return acc;
}

const ctx: ReqContext = {
  items: goldenContext().items,
  recipes: goldenState.recipes,
  conv: goldenContext().conv,
};

describe('reqExpand quantity semantics equal legacy (all 321 cards)', () => {
  it('qty and from-maps identical; cost identical for every entry that needed no conversion', () => {
    let costChecked = 0;
    for (const r of goldenState.recipes) {
      const legacy = legacyExpand(r, 7);
      const res = newReqResult();
      reqExpand(r, 7, ctx, res);
      expect(Object.keys(res.acc).sort(), r.code).toEqual(Object.keys(legacy).sort());
      for (const k of Object.keys(legacy)) {
        expect(res.acc[k]!.qty, `${r.code} ${k}`).toBe(legacy[k]!.qty);
        if (k[0] !== '?' && res.acc[k]!.purchaseQty === res.acc[k]!.qty) {
          costChecked++;
          expect(res.acc[k]!.cost, `${r.code} ${k} cost`).toBe(legacy[k]!.cost);
        }
        if (k[0] !== '?') expect(res.acc[k]!.from).toEqual(legacy[k]!.from);
      }
    }
    expect(costChecked).toBeGreaterThan(1000);
  });
});

describe('conversion-aware valuation (D-10)', () => {
  const item = (code: string, price: number | null, uom: string): CostItem => ({ code, name: code, uom, price });
  const rec = (code: string, lines: CostLine[], o: Partial<CostRecipe> = {}): CostRecipe => ({
    code,
    name: code,
    type: 'menu',
    output: 1,
    subQty: 0,
    subUom: 'Gram',
    batchOut: 0,
    batchUom: 'Gram',
    price: 0,
    lines,
    ...o,
  });
  const mk = (
    items: CostItem[],
    recipes: CostRecipe[],
    conv: [string, readonly [string, number]][] = [],
  ): ReqContext => ({
    items: new Map(items.map((i) => [i.code, i])),
    recipes,
    conv: new Map(conv),
  });

  it('gram line on an Each item is divided by the factor (legacy priced it 50x too high)', () => {
    const r = rec('X', [{ code: 'EGG', qty: 100, unit: 'Gram', y: 1 }]);
    const c = mk([item('EGG', 2, 'Each')], [r], [['EGG', ['Gram', 50]]]);
    const res = newReqResult();
    reqExpand(r, 1, c, res);
    expect(res.acc.EGG!.qty).toBe(100);
    expect(res.acc.EGG!.purchaseQty).toBe(2);
    expect(res.acc.EGG!.cost).toBe(4);
    expect(res.flags).toEqual([]);
  });

  it('unconvertible lines are valued 0 and flagged', () => {
    const r = rec('X', [{ code: 'EGG', qty: 100, unit: 'Gram', y: 1 }]);
    const res = newReqResult();
    reqExpand(r, 1, mk([item('EGG', 2, 'Each')], [r]), res);
    expect(res.acc.EGG!.cost).toBe(0);
    expect(res.flags).toEqual([{ kind: 'unconvertible', recipe: 'X', code: 'EGG', lineUnit: 'Gram', itemUom: 'Each' }]);
  });

  it('null price is valued 0 and flagged; unknown code goes to the ?bucket and is flagged', () => {
    const r = rec('X', [
      { code: 'A', qty: 1, unit: 'Gram', y: 1 },
      { code: 'ZZ', qty: 2, unit: 'Gram', y: 1 },
    ]);
    const res = newReqResult();
    reqExpand(r, 1, mk([item('A', null, 'Gram')], [r]), res);
    expect(res.flags.map((f) => f.kind).sort()).toEqual(['no-price', 'unknown-code']);
    expect(res.acc['?ZZ']).toMatchObject({ name: '(not in library)', qty: 2, cost: 0 });
  });

  it('blank-code rows are skipped (D-46) and never flagged or bucketed', () => {
    const r = rec('X', [
      { code: '', qty: 5, unit: 'Gram', y: 1 },
      { code: 'A', qty: 1, unit: 'Gram', y: 1 },
    ]);
    const res = newReqResult();
    reqExpand(r, 1, mk([item('A', 1, 'Gram')], [r]), res);
    expect(Object.keys(res.acc)).toEqual(['A']);
    expect(res.flags).toEqual([]);
  });

  it('the same problem reached repeatedly is flagged once', () => {
    const r = rec('X', [{ code: 'ZZ', qty: 1, unit: 'Gram', y: 1 }]);
    const res = newReqResult();
    for (let i = 0; i < 500; i++) reqExpand(r, 1, mk([], [r]), res);
    expect(res.flags).toHaveLength(1);
    expect(res.acc['?ZZ']!.qty).toBe(500);
  });

  it('y is unclamped (||1), unlike costing', () => {
    const r = rec('X', [{ code: 'A', qty: 100, unit: 'Gram', y: 20 }]);
    const res = newReqResult();
    reqExpand(r, 1, mk([item('A', 1, 'Gram')], [r]), res);
    expect(res.acc.A!.qty).toBe(5);
  });

  it('sub match is case-insensitive, any type, first match wins; depth > 4 is truncated AND flagged', () => {
    const chain = Array.from({ length: 7 }, (_, i) =>
      rec(
        `c${i}`,
        i < 6 ? [{ code: `C${i + 1}`, qty: 1, unit: 'Gram', y: 1 }] : [{ code: 'A', qty: 1, unit: 'Gram', y: 1 }],
      ),
    );
    const res = newReqResult();
    reqExpand(chain[0]!, 1, mk([item('A', 1, 'Gram')], chain), res);
    expect(res.acc.A).toBeUndefined();
    expect(res.flags.some((f) => f.kind === 'truncated')).toBe(true);
    const ok = newReqResult();
    reqExpand(chain[2]!, 1, mk([item('A', 1, 'Gram')], chain), ok); // c2..c6 = depths 0..4
    expect(ok.acc.A!.qty).toBe(1);
    expect(ok.flags).toEqual([]);
  });

  it('flags the sub-recipe portions/quantity scale mismatch of legacy semantics', () => {
    const sub = rec('SUB', [{ code: 'A', qty: 500, unit: 'Gram', y: 1 }], { type: 'sub', output: 1, batchOut: 500 });
    const top = rec('TOP', [{ code: 'SUB', qty: 100, unit: 'Gram', y: 1 }]);
    const res = newReqResult();
    reqExpand(top, 1, mk([item('A', 0.01, 'Gram')], [sub, top]), res);
    expect(res.acc.A!.qty).toBe(50000); // legacy: 100 "portions" x 500 g
    expect(res.flags).toEqual([
      { kind: 'sub-scale', recipe: 'TOP', sub: 'SUB', legacyPortions: 100, costingPortions: 0.2 },
    ]);
  });
});

describe('reconciliation (D-28) on golden data', () => {
  const cards = goldenState.recipes.map((recipe) => ({ recipe, portions: Math.max(1, recipe.output || 1) }));
  const rows = reconcile(cards, ctx, goldenContext().settings);

  it('cards with no sub-recipe, conversion or unusual yield issues match within 1e-9 for one batch', () => {
    const codes = new Set(goldenState.recipes.map((r) => r.code.toUpperCase()));
    let checked = 0;
    for (const row of rows) {
      const r = goldenState.recipes.find((x) => x.code === row.code)!;
      const clean =
        row.flags.length === 0 &&
        r.lines.every(
          (l) => !codes.has((l.code || '').toUpperCase()) && (l.y == null || (l.y > 0 && l.y <= 10)) && l.code,
        );
      if (!clean) continue;
      checked++;
      expect(row.matches, `${row.code} variance ${row.variance}`).toBe(true);
    }
    expect(checked).toBeGreaterThan(250);
  });

  it('variance for buffer cards equals the buffer allowance exactly (food - batch/out*out)', () => {
    for (const row of rows.filter((x) => x.flags.length === 0).slice(0, 80)) {
      expect(row.cardValueWithBuffer - row.cardValueExBuffer).toBe(row.bufferAllowance);
    }
  });

  it('reports the differing cards: the one real sub-recipe use (GRM-MN-0001) is flagged', () => {
    const differing = rows.filter((x) => !x.matches);
    const sub = differing.find((x) => x.code === 'GRM-MN-0001');
    expect(sub).toBeDefined();
    expect(sub!.flags.some((f) => f.kind === 'sub-scale')).toBe(true);
    // every mismatch must be explained by at least one flag or a y outside (0,10]
    for (const row of differing) {
      const r = goldenState.recipes.find((x) => x.code === row.code)!;
      const yOdd = r.lines.some((l) => l.y != null && !(l.y > 0 && l.y <= 10));
      expect(row.flags.length > 0 || yOdd, `${row.code} unexplained variance ${row.variance}`).toBe(true);
    }
  });

  it('requisition total is a plain sum of entry costs', () => {
    const r = goldenState.recipes[5]!;
    const res = newReqResult();
    reqExpand(r, 3, ctx, res);
    expect(requisitionTotal(res)).toBe(Object.values(res.acc).reduce((s, e) => s + e.cost, 0));
    expect(cost(r, goldenContext()).err).toBeDefined();
  });
});
