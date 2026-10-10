import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { marginAtRisk, menuMatrix, overTarget, pareto, type MatrixInput } from '@/domain/dash-analytics';
import { newReqResult, reqExpand, type ReqContext } from '@/domain/production/requisition';
import type { CostRecipe } from '@/domain/costing';
import { dashFilters } from '@/lib/services/dash';
import { goldenContext, goldenState } from './helpers/golden';

const m = (code: string, portions: number, sp: number | null, food: number): MatrixInput => ({
  code,
  name: code,
  portions,
  sp,
  food,
});

describe('menuMatrix (D-66)', () => {
  // 4 items: portions 40/30/20/10, contribution 10/2/10/2. total 100, N 4 -> popularity cut 17.5
  // margin cut = (400 + 60 + 200 + 20)/100 = 6.8
  const rows = [m('A', 40, 20, 10), m('B', 30, 10, 8), m('C', 20, 20, 10), m('D', 10, 10, 8)];
  it('classifies by the 70% popularity cut and the portion-weighted margin cut', () => {
    const r = menuMatrix(rows);
    expect(r.popularityCut).toBeCloseTo(17.5, 12);
    expect(r.marginCut).toBeCloseTo(6.8, 12);
    const q = Object.fromEntries(r.points!.map((p) => [p.code, p.quadrant]));
    expect(q).toEqual({ A: 'star', B: 'plowhorse', C: 'star', D: 'dog' });
    expect(r.classified).toBe(4);
  });
  it('a value equal to a cut counts as high', () => {
    // two items: cut = 0.7*20/2 = 7, both contributions equal the weighted mean
    const r = menuMatrix([m('A', 10, 10, 5), m('B', 7, 10, 5)], 2);
    expect(r.points!.map((p) => p.quadrant)).toEqual(['star', 'star']);
  });
  it('shows nothing under the minimum of 4 classifiable items and keeps the count', () => {
    const r = menuMatrix(rows.slice(0, 3));
    expect(r.points).toBeNull();
    expect(r.classified).toBe(3);
  });
  it('excludes and counts unpriced (null is not 0) and unproduced cards; sorted by portions', () => {
    const r = menuMatrix([...rows, m('N', 50, null, 3), m('Z', 5, 0, 3), m('P', 0, 10, 3)]);
    expect(r.unpriced).toBe(2);
    expect(r.noProduction).toBe(1);
    expect(r.classified).toBe(4);
    expect(r.points!.map((p) => p.code)).toEqual(['A', 'B', 'C', 'D']);
  });
  it('empty input and non-finite values do not throw', () => {
    expect(menuMatrix([]).points).toBeNull();
    expect(menuMatrix([m('X', 5, 10, NaN)]).classified).toBe(0);
  });
  it('is independent of input order; classes always cover every classified item; scaling portions keeps classes', () => {
    const arb = fc.array(
      fc.record({
        portions: fc.integer({ min: 1, max: 1000 }),
        sp: fc.integer({ min: 1, max: 200 }),
        food: fc.integer({ min: 0, max: 200 }),
      }),
      { minLength: 4, maxLength: 30 },
    );
    fc.assert(
      fc.property(arb, fc.integer({ min: 2, max: 9 }), (xs, k) => {
        const inputs = xs.map((x, i) => m(`C${i}`, x.portions, x.sp, x.food));
        const a = menuMatrix(inputs);
        const b = menuMatrix([...inputs].reverse());
        const cls = (r: ReturnType<typeof menuMatrix>) =>
          Object.fromEntries(r.points!.map((p) => [p.code, p.quadrant]));
        expect(cls(a)).toEqual(cls(b));
        expect(a.points!.length).toBe(inputs.length);
        const c = menuMatrix(inputs.map((x) => ({ ...x, portions: x.portions * k })));
        expect(cls(c)).toEqual(cls(a));
      }),
    );
  });
});

describe('marginAtRisk / overTarget / pareto', () => {
  it('margin at risk = sum of max(0, food - sp x target) x portions, weighted', () => {
    const r = marginAtRisk(
      [
        { code: 'A', name: 'A', portions: 10, sp: 100, food: 40 }, // over by 10 -> 100
        { code: 'B', name: 'B', portions: 5, sp: 100, food: 30 }, // exactly at target -> 0
        { code: 'C', name: 'C', portions: 0, sp: 100, food: 90 }, // no production
        { code: 'D', name: 'D', portions: 3, sp: null, food: 90 }, // unpriced: never 0
      ],
      0.3,
    );
    expect(r.rows.map((x) => x.code)).toEqual(['A']);
    expect(r.total).toBeCloseTo(100, 12);
    expect(r.rows[0]!.fcPct).toBeCloseTo(0.4, 12);
  });
  it('over target ranks the biggest gap first and skips unpriced cards', () => {
    const r = overTarget(
      [
        { code: 'A', name: 'A', sp: 10, fcPct: 0.35 },
        { code: 'B', name: 'B', sp: 10, fcPct: 0.5 },
        { code: 'C', name: 'C', sp: 0, fcPct: 0.9 },
        { code: 'D', name: 'D', sp: 10, fcPct: 0.3 },
      ],
      0.3,
    );
    expect(r.map((x) => x.code)).toEqual(['B', 'A']);
    expect(r[0]!.gap).toBeCloseTo(0.2, 12);
  });
  it('pareto: running share, A to 80% / B to 95% / C tail; shares sum to 1; zero-cost rows dropped', () => {
    const rows = pareto([
      { item: 'a', cost: 70 },
      { item: 'b', cost: 15 },
      { item: 'c', cost: 10 },
      { item: 'd', cost: 5 },
      { item: 'z', cost: 0 },
    ]);
    expect(rows.map((r) => [r.item, r.cls])).toEqual([
      ['a', 'A'],
      ['b', 'A'],
      ['c', 'B'],
      ['d', 'C'],
    ]);
    expect(rows.reduce((a, r) => a + r.share, 0)).toBeCloseTo(1, 12);
    expect(rows.at(-1)!.cumulative).toBeCloseTo(1, 12);
    expect(pareto([])).toEqual([]);
  });
});

describe('reqExpand recipe lookup map (perf fix) keeps the old find() behaviour', () => {
  const c = goldenContext();
  const [i1, i2] = [...c.items.keys()];
  const line = (code: string) =>
    ({ code, qty: 2, unit: c.items.get(code)?.uom ?? '', y: 1 }) as CostRecipe['lines'][number];
  const rec = (code: string, lines: CostRecipe['lines']): CostRecipe =>
    ({ ...goldenState.recipes[0]!, code, name: code, output: 1, type: 'sub', lines }) as CostRecipe;
  it('a line pointing at a code matches case-insensitively and the FIRST duplicate in list order wins', () => {
    const first = rec('dup', [line(i1!)]);
    const second = rec('DUP', [line(i2!)]);
    const top = rec('TOP', [{ ...line(i1!), code: 'Dup' }]);
    const ctx: ReqContext = { items: c.items, recipes: [top, first, second], conv: c.conv };
    const res = newReqResult();
    reqExpand(top, 1, ctx, res);
    expect(Object.keys(res.acc)).toEqual([i1]); // reached through the first "dup", never the second
    const swapped = newReqResult();
    reqExpand(top, 1, { ...ctx, recipes: [top, second, first] }, swapped);
    expect(Object.keys(swapped.acc)).toEqual([i2]);
  });
  it('an unknown code still lands in the ?code bucket', () => {
    const top = rec('TOP', [line('NOPE-1')]);
    const res = newReqResult();
    reqExpand(top, 1, { items: c.items, recipes: [top], conv: c.conv }, res);
    expect(Object.keys(res.acc)).toEqual(['?NOPE-1']);
  });
});

describe('dashFilters (D-65)', () => {
  const ok = (o: object) => dashFilters.safeParse(o);
  it('empty means all; bounds are day-level ISO dates', () => {
    const r = ok({});
    expect(r.success && r.data).toEqual({ brand: '*', loc: '*' });
    expect(ok({ from: '2026-10-01', to: '2026-10-31' }).success).toBe(true);
  });
  it('rejects bad shapes, impossible dates, inverted and over-long ranges', () => {
    expect(ok({ from: '2026-10' }).success).toBe(false);
    expect(ok({ from: '2026-02-30' }).success).toBe(false);
    expect(ok({ from: '2026-10-31', to: '2026-10-01' }).success).toBe(false);
    expect(ok({ from: '2025-01-01', to: '2026-01-03' }).success).toBe(false); // 367 days
    expect(ok({ from: '2025-01-01', to: '2026-01-02' }).success).toBe(true); // 366 days
    expect(ok({ from: '2025-01-01' }).success).toBe(true); // an open bound is fine
    expect(ok({ loc: 'x'.repeat(41) }).success).toBe(false);
  });
});
