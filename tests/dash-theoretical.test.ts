import { describe, expect, it } from 'vitest';
import type { ConvEntry, CostItem, CostRecipe } from '@/domain/costing';
import {
  actualUsage,
  costingYield,
  rankTva,
  theoreticalUsage,
  tvaRow,
  verdictOf,
  type Usage,
} from '@/domain/dash-analytics/theoretical';
import type { ReqContext } from '@/domain/production/requisition';

const item = (code: string, price: number | null = 2, uom = 'Gram'): CostItem => ({ code, name: code, uom, price });
const card = (
  code: string,
  lines: CostRecipe['lines'],
  over: Partial<CostRecipe> = {},
  type: CostRecipe['type'] = 'menu',
): CostRecipe => ({
  code,
  name: code,
  type,
  output: 1,
  subQty: 0,
  subUom: '',
  batchOut: 0,
  batchUom: '',
  price: 10,
  lines,
  ...over,
});
const ctxOf = (items: CostItem[], recipes: CostRecipe[], conv: [string, ConvEntry][] = []): ReqContext => ({
  items: new Map(items.map((i) => [i.code, i])),
  recipes,
  conv: new Map(conv),
});
const use = (r: CostRecipe, portions: number, ctx: ReqContext, buffer = 0.1) => {
  const m = new Map<string, Usage>();
  theoreticalUsage(r, portions, ctx, buffer, m);
  return m;
};

describe('theoreticalUsage (D-74)', () => {
  it('is qty / output x portions / y in purchase units, with the settings buffer as allowance', () => {
    const r = card('M', [{ code: 'A', qty: 100, unit: 'Gram', y: 0.8 }], { output: 2 });
    const u = use(r, 10, ctxOf([item('A')], [r])).get('A')!;
    expect(u.theoretical).toBeCloseTo(((100 / 2) * 10) / 0.8, 9);
    expect(u.extra).toBeCloseTo(u.theoretical * 0.1, 9);
    expect(u.flagged).toBe(false);
  });

  it('allowance per line: the line yp, else the card buffer, else the settings buffer (0 stays 0)', () => {
    const r = card(
      'M',
      [
        { code: 'A', qty: 10, unit: 'Gram', yp: 50 },
        { code: 'B', qty: 10, unit: 'Gram' },
        { code: 'C', qty: 10, unit: 'Gram', yp: 0 },
      ],
      { buffer: 0.2 },
    );
    const m = use(r, 1, ctxOf([item('A'), item('B'), item('C')], [r]));
    expect(m.get('A')!.extra).toBeCloseTo(5, 9);
    expect(m.get('B')!.extra).toBeCloseTo(2, 9); // card buffer 20%
    expect(m.get('C')!.extra).toBe(0);
    const noBuf = card('N', [{ code: 'B', qty: 10, unit: 'Gram' }]);
    expect(use(noBuf, 1, ctxOf([item('B')], [noBuf]), 0.1).get('B')!.extra).toBeCloseTo(1, 9); // settings buffer
  });

  it('uses the costing yield rule: outside (0,10] counts as 1', () => {
    expect(costingYield(0.5)).toBe(0.5);
    expect(costingYield(10)).toBe(10);
    expect(costingYield(20)).toBe(1);
    expect(costingYield(0)).toBe(1);
    expect(costingYield(-2)).toBe(1);
    const r = card('M', [{ code: 'A', qty: 100, unit: 'Gram', y: 20 }]);
    expect(use(r, 1, ctxOf([item('A')], [r])).get('A')!.theoretical).toBeCloseTo(100, 9);
  });

  it('converts to the purchase unit and flags a line with no conversion (it adds 0, no verdict)', () => {
    const r = card('M', [
      { code: 'A', qty: 500, unit: 'Kg' },
      { code: 'B', qty: 5, unit: 'Cup' },
    ]);
    const ctx = ctxOf([item('A'), item('B')], [r], [['A', ['Kg', 0.001]]]); // 0.001 Kg per Gram
    const m = use(r, 1, ctx);
    expect(m.get('A')!.theoretical).toBeCloseTo(500 / 0.001, 6);
    expect(m.get('B')).toMatchObject({ theoretical: 0, flagged: true });
  });

  it('a sub-recipe line carries the top-level line allowance to everything under it', () => {
    const sub = card('SUB', [{ code: 'A', qty: 10, unit: 'Gram' }], { batchOut: 1, subQty: 1, buffer: 0.9 }, 'sub');
    const r = card('M', [{ code: 'SUB', qty: 1, unit: 'Each', yp: 25 }]);
    const u = use(r, 2, ctxOf([item('A')], [r, sub])).get('A')!;
    expect(u.theoretical).toBeCloseTo(20, 9);
    expect(u.extra).toBeCloseTo(5, 9); // 25% of the card line, not the sub's own 90% buffer
  });

  it('nothing for zero portions, blank lines or unknown codes', () => {
    const r = card('M', [
      { code: '', qty: 5, unit: 'Gram' },
      { code: 'ZZ', qty: 5, unit: 'Gram' },
    ]);
    expect(use(r, 0, ctxOf([], [r])).size).toBe(0);
    expect(use(r, 3, ctxOf([], [r])).size).toBe(0);
  });
});

describe('verdict and rows (D-74)', () => {
  it('within up to the ceiling, over above it, under below 80% of theoretical', () => {
    expect(verdictOf(100, 110, 110)).toBe('within');
    expect(verdictOf(100, 110, 110.01)).toBe('over');
    expect(verdictOf(100, 110, 80)).toBe('within');
    expect(verdictOf(100, 110, 79.9)).toBe('under');
    expect(verdictOf(0, 0, 0)).toBe('within');
    expect(verdictOf(0, 0, 3)).toBe('over');
  });

  it('actual = opening + receipts - closing, and any missing count is n/a, never 0', () => {
    expect(actualUsage(100, 50, 30)).toBe(120);
    expect(actualUsage(undefined, 50, 30)).toBeNull();
    expect(actualUsage(100, 0, null)).toBeNull();
    expect(actualUsage(0, 0, 0)).toBe(0);
  });

  it('a row carries deviation and value; unpriced = quantity only; flagged = no verdict', () => {
    const u: Usage = { theoretical: 100, extra: 10, flagged: false };
    expect(tvaRow({ code: 'A', name: 'A', uom: 'Gram', price: 2, usage: u, actual: 130 })).toMatchObject({
      deviation: 30,
      value: 60,
      verdict: 'over',
      ceiling: 110,
      theoreticalValue: 200,
    });
    expect(tvaRow({ code: 'A', name: 'A', uom: 'Gram', price: null, usage: u, actual: 130 })).toMatchObject({
      deviation: 30,
      value: null,
      verdict: 'over',
      priced: false,
    });
    expect(tvaRow({ code: 'A', name: 'A', uom: 'Gram', price: 2, usage: u, actual: null })).toMatchObject({
      actual: null,
      deviation: null,
      value: null,
      verdict: null,
    });
    expect(
      tvaRow({ code: 'A', name: 'A', uom: 'Gram', price: 2, usage: { ...u, flagged: true }, actual: 500 }),
    ).toMatchObject({ actual: null, deviation: null, verdict: null, flagged: true });
  });

  it('ranks by absolute deviation value, then unpriced by quantity, then theoretical-only by value', () => {
    const mk = (code: string, price: number | null, T: number, actual: number | null) =>
      tvaRow({ code, name: code, uom: 'Gram', price, usage: { theoretical: T, extra: 0, flagged: false }, actual });
    const rows = rankTva([
      mk('TH', 1, 1000, null),
      mk('SMALL', 1, 100, 110), // value 10
      mk('BIG', 1, 100, 40), // value -60
      mk('NOPRICE', null, 100, 300), // quantity 200, no value
      mk('TH2', 5, 10, null),
    ]);
    expect(rows.map((r) => r.code)).toEqual(['BIG', 'SMALL', 'NOPRICE', 'TH', 'TH2']);
  });
});
