import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  buildContext,
  cost,
  costWithIssues,
  type ConvEntry,
  type CostItem,
  type CostLine,
  type CostRecipe,
  type CostSettings,
} from '@/domain/costing';
import { goldenContext, goldenCosts, goldenState } from './helpers/golden';

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
const L = (code: string, qty = 1, unit = 'Gram', y: number | null = 1): CostLine => ({ code, qty, unit, y });
const ctxOf = (items: CostItem[], recipes: CostRecipe[], conv: [string, ConvEntry][] = []) =>
  buildContext(items, recipes, conv, S);

describe('D-42 costWithIssues', () => {
  it('numbers are identical to cost() (golden: all 321 cards, nothing added except complete/issues)', () => {
    const ctx = goldenContext();
    for (const r of goldenState.recipes) {
      const { complete, issues, ...rest } = costWithIssues(r, ctx);
      expect(rest).toEqual(cost(r, ctx));
      expect(rest).toEqual(goldenCosts[`${r.code}|${r.id}`]);
      expect(complete).toBe(issues.length === 0);
      expect(complete).toBe(rest.err === '');
    }
  });

  it('a clean card is complete with no issues', () => {
    const c = costWithIssues(rec('X', [L('A', 10)]), ctxOf([item('A', 1)], []));
    expect(c.complete).toBe(true);
    expect(c.issues).toEqual([]);
  });

  it('reports every problem, not just the first (legacy kept one err string)', () => {
    const ctx = ctxOf([item('NP', null), item('EGG', 2, 'Each')], [rec('M', [])]);
    const c = costWithIssues(rec('X', [L('NP'), L('EGG', 1, 'Gram'), L('NOPE'), L('M')]), ctx);
    expect(c.complete).toBe(false);
    expect(c.err).toBe('missing unit conversion'); // legacy precedence unchanged
    expect(c.issues.map((i) => i.kind).sort()).toEqual([
      'missing-conversion',
      'no-price',
      'not-a-sub-recipe',
      'unknown-code',
    ]);
    expect(c.issues.find((i) => i.kind === 'missing-conversion')).toMatchObject({
      code: 'EGG',
      detail: { lineUnit: 'Gram', itemUom: 'Each' },
    });
  });

  it('nested problems carry the path down to the card that holds the line', () => {
    const inner = rec('INNER', [L('NP')], { type: 'sub', batchOut: 10 });
    const outer = rec('OUTER', [L('INNER')], { type: 'sub', batchOut: 10 });
    const c = costWithIssues(rec('TOP', [L('OUTER')]), ctxOf([item('NP', null)], [inner, outer]));
    expect(c.issues).toEqual([{ kind: 'no-price', recipe: 'TOP', path: ['TOP', 'OUTER', 'INNER'], code: 'NP' }]);
  });

  it('circular and no-batch-output', () => {
    const a = rec('RA', [L('RB')], { type: 'sub', batchOut: 1 });
    const b = rec('RB', [L('RA')], { type: 'sub', batchOut: 1 });
    const circ = costWithIssues(a, ctxOf([], [a, b]));
    expect(circ.issues.map((i) => i.kind)).toContain('circular');
    const nb = rec('NB', [L('A')], { type: 'sub', batchOut: 0, subQty: 0 });
    const c = costWithIssues(rec('P', [L('NB')]), ctxOf([item('A', 1)], [nb]));
    expect(c.issues).toEqual([{ kind: 'no-batch-output', recipe: 'P', path: ['P', 'NB'], code: 'NB' }]);
  });

  it('the same problem reached twice at the same place is reported once', () => {
    const c = costWithIssues(rec('X', [L('NP'), L('NP')]), ctxOf([item('NP', null)], []));
    expect(c.issues).toHaveLength(1);
  });

  it('blank lines are ignored', () => {
    expect(costWithIssues(rec('X', [L(''), L('A')]), ctxOf([item('A', 1)], [])).complete).toBe(true);
  });

  it('property: complete <=> err is empty, for arbitrary (possibly cyclic) graphs', () => {
    const lineArb = fc.record({
      code: fc.constantFrom('A', 'NP', 'EGG', 'S1', 'S2', 'M', 'NOPE', ''),
      qty: fc.double({ min: 0, max: 100, noNaN: true }),
      unit: fc.constantFrom('Gram', 'Ml', 'Each'),
      y: fc.constant(1),
    });
    const sub = (code: string, bo: number) =>
      fc.array(lineArb, { maxLength: 4 }).map((lines) => rec(code, lines, { type: 'sub', batchOut: bo }));
    fc.assert(
      fc.property(fc.tuple(sub('S1', 10), sub('S2', 0), sub('TOP', 5)), fc.boolean(), ([s1, s2, top], withConv) => {
        const ctx = ctxOf(
          [item('A', 1), item('NP', null), item('EGG', 2, 'Each')],
          [s1, s2, top, rec('M', [])],
          withConv ? [['EGG', ['Gram', 50]]] : [],
        );
        const c = costWithIssues(top, ctx);
        expect(c.complete).toBe(c.err === '');
        expect(c.complete).toBe(c.issues.length === 0);
        expect(c.food).toBe(cost(top, ctx).food);
      }),
      { numRuns: 500 },
    );
  });
});
