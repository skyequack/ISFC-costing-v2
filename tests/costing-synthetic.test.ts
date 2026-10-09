import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  buildContext,
  cost,
  num,
  type ConvEntry,
  type CostItem,
  type CostLine,
  type CostRecipe,
  type CostSettings,
} from '@/domain/costing';
import { goldenContext, goldenState } from './helpers/golden';

const S: CostSettings = { pkg: 0.1, del: 0.1, lab: 0.25, ops: 0.05, buffer: 0.15, target: 0.3, vat: 0.15 };

const item = (code: string, price: number | null, uom = 'Gram'): CostItem => ({ code, name: code, uom, price });
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
const ctxOf = (
  items: CostItem[],
  recipes: CostRecipe[],
  conv: [string, ConvEntry][] = [],
  st: Partial<CostSettings> = {},
) => buildContext(items, recipes, conv, { ...S, ...st });
const L = (code: string, qty: number, unit = 'Gram', y: number | null = 1, yp?: number | null): CostLine => ({
  code,
  qty,
  unit,
  y,
  yp,
});

describe('priced invariants on every golden card (sp = 100)', () => {
  const ctx = goldenContext();
  it('totalCost = food + 0.5*sp, net, vatPrice, suggest', () => {
    for (const r of goldenState.recipes) {
      const c = cost({ ...r, price: 100 }, ctx);
      expect(c.totalCost).toBeCloseTo(c.food + 50, 9);
      expect(c.net).toBeCloseTo(100 - c.totalCost, 9);
      expect(c.vatPrice).toBeCloseTo(115, 9);
      expect(c.suggest).toBeCloseTo(c.food / 0.3, 9);
      expect(c.fcPct).toBeCloseTo(c.food / 100, 12);
    }
  });
  it('a vat-only change moves only vatPrice', () => {
    const a = goldenContext(),
      b = goldenContext({ vat: 0.2 });
    for (const r of goldenState.recipes.slice(0, 40)) {
      const x = cost({ ...r, price: 100 }, a),
        y = cost({ ...r, price: 100 }, b);
      expect({ ...x, vatPrice: 0 }).toEqual({ ...y, vatPrice: 0 });
      expect(y.vatPrice).toBeCloseTo(120, 9);
    }
  });
});

describe('worked example: food=30', () => {
  it('fc 30%, pkg 10, del 10, lab 25, ops 5, total 80, net 20, suggest 100, vat 115', () => {
    // batch 26.0869565.. with default 15% buffer -> food 30 exactly: use yp=0 so food = line cost
    const ctx = ctxOf([item('A', 0.3)], []);
    const c = cost(rec('X', [L('A', 100, 'Gram', 1, 0)], { price: 100 }), ctx);
    expect(c.food).toBeCloseTo(30, 12);
    expect(c.fcPct).toBeCloseTo(0.3, 12);
    expect([c.pkg, c.del, c.lab, c.ops]).toEqual([10, 10, 25, 5]);
    expect(c.totalCost).toBeCloseTo(80, 12);
    expect(c.net).toBeCloseTo(20, 12);
    expect(c.npPct).toBeCloseTo(0.2, 12);
    expect(c.suggest).toBeCloseTo(100, 9);
    expect(c.vatPrice).toBeCloseTo(115, 12);
  });
  it('repeats with output>1 (food per portion)', () => {
    const ctx = ctxOf([item('A', 0.3)], []);
    const c = cost(rec('X', [L('A', 300, 'Gram', 1, 0)], { price: 100, output: 3 }), ctx);
    expect(c.food).toBeCloseTo(30, 12);
    expect(c.out).toBe(3);
  });
});

describe('yield matrix', () => {
  const ctx = ctxOf([item('A', 1)], []);
  const food = (y: number | null, yp?: number | null, buffer?: number | null) =>
    cost(rec('X', [L('A', 100, 'Gram', y, yp)], { buffer }), ctx).food;
  it.each([
    [0, 100],
    [-1, 100],
    [NaN, 100],
    [11, 100],
    [1, 100],
    [0.5, 200],
    [10, 10],
  ])('y=%s is treated as divisor (<=0 or >10 -> 1)', (y, base) => {
    expect(food(y, 0)).toBeCloseTo(base, 9);
  });
  it('yp=0 stays 0; null falls back to card buffer then settings.buffer; 15 -> 15%', () => {
    expect(food(1, 0)).toBeCloseTo(100, 9);
    expect(food(1, null)).toBeCloseTo(115, 9); // settings 0.15
    expect(food(1, undefined, 0.5)).toBeCloseTo(150, 9); // card buffer
    expect(food(1, null, 0)).toBeCloseTo(100, 9); // card buffer 0 is a real value
    expect(food(1, 15)).toBeCloseTo(115, 9);
  });
  it('double waste (y and yp) both apply', () => {
    expect(food(0.5, 20)).toBeCloseTo(240, 9);
  });
});

describe('edge cases', () => {
  it('null-price item costs 0 and reports no price', () => {
    const c = cost(rec('X', [L('A', 10)]), ctxOf([item('A', null)], []));
    expect(c.err).toBe('no price');
    expect(c.batch).toBe(0);
  });
  it('unknown code and menu-type code as line', () => {
    expect(cost(rec('X', [L('NOPE', 1)]), ctxOf([], [])).err).toBe('unknown code');
    const m = rec('M', []);
    expect(cost(rec('X', [L('M', 1)]), ctxOf([], [m])).err).toBe('not a sub-recipe');
  });
  it('blank-code lines are skipped everywhere', () => {
    const c = cost(rec('X', [L('', 5), L('A', 10)]), ctxOf([item('A', 1)], []));
    expect(c.batch).toBe(10);
    expect(c.autoOut).toBe(10);
  });
  it('conversion divides by the factor when stored unit == line unit', () => {
    const ctx = ctxOf([item('EGG', 2, 'Each')], [], [['EGG', ['Gram', 50]]]);
    const c = cost(rec('X', [L('EGG', 100, 'Gram', 1, 0)]), ctx);
    expect(c.batch).toBeCloseTo(4, 12); // 100/50 * 2
  });
  it('missing, wrong-unit and zero-factor conversions cost 0 and flag', () => {
    for (const conv of [[], [['EGG', ['Ml', 50]]], [['EGG', ['Gram', 0]]]] as [string, ConvEntry][][]) {
      const c = cost(rec('X', [L('EGG', 100, 'Gram')]), ctxOf([item('EGG', 2, 'Each')], [], conv));
      expect(c.batch).toBe(0);
      expect(c.err).toBe('missing unit conversion');
    }
  });
  it('missing conversion wins over an earlier error', () => {
    const c = cost(rec('X', [L('NOPE', 1), L('EGG', 1, 'Gram')]), ctxOf([item('EGG', 2, 'Each')], []));
    expect(c.err).toBe('missing unit conversion');
  });
  it('unit comparison is case/space-insensitive', () => {
    const c = cost(rec('X', [L('A', 10, ' GRAM ', 1, 0)]), ctxOf([item('A', 1, 'gram')], []));
    expect(c.batch).toBe(10);
  });
});

describe('sub-recipes', () => {
  const sub = rec('SUB', [L('A', 1000, 'Gram', 1, 0)], { type: 'sub', batchOut: 500, subUom: 'Gram' });
  const items = [item('A', 0.01)];
  it('unit cost has no buffer; buffer applied once in the parent (1.15, not 1.1025)', () => {
    const ctx = ctxOf(items, [sub]);
    expect(cost(sub, ctx).unitCost).toBeCloseTo(10 / 500, 12);
    const parent = rec('P', [L('SUB', 100, 'Gram', 1)]);
    const c = cost(parent, ctxOf(items, [sub, parent]));
    expect(c.batch).toBeCloseTo(100 * (10 / 500), 12);
    expect(c.food).toBeCloseTo(c.batch * 1.15, 12);
  });
  it('sub with no batch output', () => {
    const bad = rec('BAD', [L('A', 1)], { type: 'sub', batchOut: 0, subQty: 0 });
    const c = cost(rec('P', [L('BAD', 1)]), ctxOf(items, [bad]));
    expect(c.err).toBe('no batch output');
  });
  it('falls back to subQty when batchOut is 0', () => {
    const s = rec('S2', [L('A', 100, 'Gram', 1, 0)], { type: 'sub', batchOut: 0, subQty: 50 });
    expect(cost(s, ctxOf(items, [s])).unitCost).toBeCloseTo(1 / 50, 12);
  });
  it('sub-of-sub resolves', () => {
    const top = rec('TOP', [L('SUB', 10)], { type: 'sub', batchOut: 10 });
    const c = cost(rec('P', [L('TOP', 5)]), ctxOf(items, [sub, top]));
    expect(c.err).toBe('');
    expect(c.batch).toBeGreaterThan(0);
  });
  it('cycles terminate and flag circular (self, A->B->A)', () => {
    const self = rec('RA', [L('RA', 1)], { type: 'sub', batchOut: 1 });
    expect(cost(self, ctxOf(items, [self])).err).toBe('circular');
    const a = rec('RA', [L('RB', 1)], { type: 'sub', batchOut: 1 });
    const b = rec('RB', [L('RA', 1)], { type: 'sub', batchOut: 1 });
    expect(cost(a, ctxOf(items, [a, b])).err).toBe('circular');
  });
  it('last card wins on duplicate codes', () => {
    const one = rec('D', [L('A', 100, 'Gram', 1, 0)], { type: 'sub', batchOut: 100 });
    const two = rec('D', [L('A', 200, 'Gram', 1, 0)], { type: 'sub', batchOut: 100 });
    const c = cost(rec('P', [L('D', 100, 'Gram', 1, 0)]), ctxOf(items, [one, two]));
    expect(c.batch).toBeCloseTo(2, 12);
  });
  it('items win over recipes with the same code', () => {
    const shadow = rec('A', [], { type: 'sub', batchOut: 1 });
    const c = cost(rec('P', [L('A', 10, 'Gram', 1, 0)]), ctxOf(items, [shadow]));
    expect(c.batch).toBeCloseTo(0.1, 12);
  });
});

describe('batch output & misc fields', () => {
  it('auto output buckets by unit; manual output wins', () => {
    const ctx = ctxOf([item('A', 1)], []);
    const c = cost(rec('X', [L('A', 100, 'Gram'), L('A', 50, 'Ml'), L('A', 2, 'Each')]), ctx);
    expect([c.gramTotal, c.mlTotal, c.eaTotal, c.autoOut, c.autoUom, c.bUom]).toEqual([
      100,
      50,
      2,
      100,
      'Gram',
      'Gram',
    ]);
    const m = cost(rec('X', [L('A', 100, 'Gram')], { batchOut: 7, batchUom: 'Slice', output: 7 }), ctx);
    expect([m.bOut, m.bUom, m.manualOut, m.portion]).toEqual([7, 'Slice', true, 1]);
  });
  it('sp=0 gives null percentages and zero overheads', () => {
    const c = cost(rec('X', [L('A', 1)]), ctxOf([item('A', 1)], []));
    expect([c.fcPct, c.tcPct, c.npPct, c.pkg, c.vatPrice]).toEqual([null, null, null, 0, 0]);
  });
  it('num() coerces like parseFloat', () => {
    expect([num('12.5kg'), num(null), num(undefined), num('x'), num(Infinity), num(3)]).toEqual([12.5, 0, 0, 0, 0, 3]);
  });
});

describe('property tests', () => {
  const lineArb = fc.record({
    code: fc.constantFrom('A', 'B', 'S1', 'S2', 'S3', 'NOPE', ''),
    qty: fc.double({ min: 0, max: 1000, noNaN: true }),
    unit: fc.constantFrom('Gram', 'Ml', 'Each'),
    y: fc.option(fc.oneof(fc.constant(0), fc.constant(-1), fc.double({ min: 0.01, max: 12, noNaN: true })), {
      nil: undefined,
    }),
    yp: fc.option(fc.double({ min: 0, max: 100, noNaN: true }), { nil: null }),
  });
  const recArb = (code: string) =>
    fc.array(lineArb, { maxLength: 5 }).map((lines) => rec(code, lines, { type: 'sub', batchOut: 10 }));

  it('arbitrary (possibly cyclic) recipe graphs always terminate with finite non-negative cost', () => {
    fc.assert(
      fc.property(fc.tuple(recArb('S1'), recArb('S2'), recArb('S3'), recArb('TOP')), ([s1, s2, s3, top]) => {
        const ctx = ctxOf([item('A', 0.5), item('B', 1.5, 'Each')], [s1, s2, s3, top], [['B', ['Gram', 25]]]);
        const c = cost(top, ctx);
        expect(Number.isFinite(c.food)).toBe(true);
        expect(c.food).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 300 },
    );
  });

  it('scaling all quantities by k scales batch cost by k', () => {
    fc.assert(
      fc.property(
        fc.array(
          lineArb.filter((l) => l.code === 'A' || l.code === 'B'),
          { minLength: 1, maxLength: 5 },
        ),
        fc.double({ min: 0.1, max: 20, noNaN: true }),
        (lines, k) => {
          const ctx = ctxOf([item('A', 0.5), item('B', 1.5, 'Each')], [], [['B', ['Gram', 25]]]);
          const a = cost(rec('X', lines), ctx).batch;
          const b = cost(
            rec(
              'X',
              lines.map((l) => ({ ...l, qty: l.qty * k })),
            ),
            ctx,
          ).batch;
          expect(Math.abs(b - a * k)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(a * k)));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('repricing +10% of one ingredient moves each dependent card by exactly qty*price*(1+yp)/(y*out)*0.1', () => {
    const ctx0 = goldenContext();
    const nested = new Set(goldenState.recipes.filter((r) => r.type === 'sub').map((r) => r.code));
    // deterministic: the 5 priced ingredients used by the most cards
    const uses = new Map<string, number>();
    for (const r of goldenState.recipes)
      for (const c of new Set(r.lines.map((l) => l.code)))
        if (ctx0.items.get(c)?.price) uses.set(c, (uses.get(c) ?? 0) + 1);
    const top = [...uses.entries()]
      .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
      .slice(0, 5)
      .map(([c]) => c);
    let exact = 0,
      untouched = 0;
    for (const code of top) {
      const bumped = goldenState.items.map((i) => (i.code === code ? { ...i, price: i.price! * 1.1 } : i));
      const ctx1 = buildContext(bumped, goldenState.recipes, Object.entries(goldenState.conv), ctx0.settings);
      for (const r of goldenState.recipes) {
        const direct = r.lines.some((l) => l.code === code);
        const usesSub = r.lines.some((l) => nested.has(l.code));
        const d = cost(r, ctx1).food - cost(r, ctx0).food;
        if (!direct && !usesSub) {
          untouched++;
          expect(d).toBe(0);
        }
        const sameUnit = r.lines
          .filter((l) => l.code === code)
          .every((l) => String(l.unit).toLowerCase() === String(ctx0.items.get(code)!.uom).toLowerCase());
        if (direct && !usesSub && sameUnit) {
          exact++;
          const buf = r.buffer != null ? r.buffer : ctx0.settings.buffer;
          const out = Math.max(1, num(r.output) || 1);
          let expected = 0;
          for (const l of r.lines.filter((x) => x.code === code)) {
            const yRaw = num(l.y),
              y = yRaw > 0 && yRaw <= 10 ? yRaw : 1;
            const p = l.yp != null ? num(l.yp) / 100 : buf;
            expected += (num(l.qty) / y) * ctx0.items.get(code)!.price! * 0.1 * (1 + p);
          }
          expect(d).toBeCloseTo(expected / out, 9);
        }
      }
    }
    expect(exact).toBeGreaterThan(50); // guard against a vacuous pass
    expect(untouched).toBeGreaterThan(500);
  });
});
