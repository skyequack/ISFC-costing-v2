import { describe, expect, it } from 'vitest';
import { buildContext, cost, type CostItem, type CostRecipe, type CostSettings } from '@/domain/costing';
import { newReqResult, reconcile, reqExpand, type ReqContext } from '@/domain/production';
import { findCycle } from '@/domain/recipes/graph';

/** Legacy tolerated malformed/partial cards (missing fields); the port must not throw on them. */
const S: CostSettings = { pkg: 0, del: 0, lab: 0, ops: 0, buffer: 0, target: 0, vat: 0 };
const bad = (o: object) => o as unknown as CostRecipe;
const it1 = (o: Partial<CostItem> = {}) => ({ code: 'A', name: 'A', uom: 'Gram', price: 1, ...o }) as CostItem;

describe('costing tolerates partial legacy data', () => {
  it('missing lines/output/unit/subUom/batchUom and target 0', () => {
    const ctx = buildContext([it1()], [], [], S);
    expect(cost(bad({ code: 'X', type: 'menu', price: 0 }), ctx).batch).toBe(0);
    const c = cost(bad({ code: 'X', type: 'menu', price: 0, lines: [{ code: 'A', qty: 5 }], batchOut: 3 }), ctx);
    expect(c.out).toBe(1);
    expect(c.eaTotal).toBe(5); // unit undefined -> 'each' bucket
    expect(c.bUom).toBe('Each'); // manual batchOut with no batchUom -> autoUom
    expect(c.suggest).toBe(0);
  });

  it('sub without subUom resolves to Gram; conversion tuple with null unit never matches', () => {
    const sub = bad({
      code: 'SUB',
      name: 'S',
      type: 'sub',
      batchOut: 10,
      lines: [{ code: 'A', qty: 10, unit: 'Gram', y: 1 }],
    });
    const ctx = buildContext([it1({ code: 'EGG', uom: 'Each' }), it1()], [sub], [['EGG', [null as never, 5]]], S);
    expect(
      cost(bad({ code: 'X', type: 'menu', price: 0, lines: [{ code: 'SUB', qty: 1, unit: 'Gram', y: 1 }] }), ctx).err,
    ).toBe('');
    expect(
      cost(bad({ code: 'X', type: 'menu', price: 0, lines: [{ code: 'EGG', qty: 1, unit: 'Gram', y: 1 }] }), ctx).err,
    ).toBe('missing unit conversion');
  });

  it('card with a line unit but an item with no uom is not a conversion case', () => {
    const ctx = buildContext([it1({ uom: undefined as never })], [], [], S);
    expect(
      cost(bad({ code: 'X', type: 'menu', price: 0, lines: [{ code: 'A', qty: 2, unit: 'Gram', y: 1 }] }), ctx).batch,
    ).toBe(2);
  });
});

describe('requisition tolerates partial legacy data', () => {
  const base = (
    items: CostItem[],
    recipes: CostRecipe[],
    conv: [string, readonly [string, number]][] = [],
  ): ReqContext => ({
    items: new Map(items.map((i) => [i.code, i])),
    recipes,
    conv: new Map(conv),
  });

  it('null/undefined recipe is a no-op; missing lines, y, unit, output', () => {
    const res = newReqResult();
    reqExpand(null, 1, base([], []), res);
    reqExpand(undefined, 1, base([], []), res);
    reqExpand(bad({ code: 'E', name: 'E', type: 'menu' }), 1, base([], []), res);
    expect(res).toEqual({ acc: {}, flags: [] });
    const r = bad({ code: 'X', name: 'X', type: 'menu', output: 0, lines: [{ code: 'A', qty: 4 }, { qty: 1 }] });
    reqExpand(r, 2, base([it1({ uom: undefined as never })], [r, bad({ name: 'nocode', type: 'menu' })]), res);
    expect(res.acc.A!.qty).toBe(8);
    expect(res.acc.A!.cost).toBe(8);
  });

  it('sub with no batch size is expanded without a scale flag; conv tuple with null unit is unconvertible', () => {
    const sub = bad({
      code: 'SUB',
      name: 'S',
      type: 'sub',
      output: 1,
      lines: [{ code: 'A', qty: 1, unit: 'Gram', y: 1 }],
    });
    const top = bad({
      code: 'TOP',
      name: 'T',
      type: 'menu',
      lines: [
        { code: 'SUB', qty: 2, unit: 'Gram', y: 1 },
        { code: 'EGG', qty: 1, unit: 'Gram', y: 1 },
      ],
    });
    const res = newReqResult();
    reqExpand(top, 1, base([it1(), it1({ code: 'EGG', uom: 'Each' })], [sub, top], [['EGG', [null as never, 5]]]), res);
    expect(res.flags.map((f) => f.kind)).toEqual(['unconvertible']);
    expect(res.acc.A!.qty).toBe(2);
  });

  it('reconcile copes with a card without output', () => {
    const r = bad({ code: 'X', name: 'X', type: 'menu', price: 0, lines: [{ code: 'A', qty: 3, unit: 'Gram', y: 1 }] });
    const rows = reconcile([{ recipe: r, portions: 1 }], base([it1()], [r]), S);
    expect(rows[0]!.requisitionValue).toBe(3);
    expect(rows[0]!.matches).toBe(true);
  });
});

describe('graph tolerates partial data', () => {
  it('recipes without lines or with null codes', () => {
    expect(
      findCycle([
        { code: null as never, lines: undefined as never },
        { code: 'B', lines: [{ code: null as never }] },
      ]),
    ).toBeNull();
  });
});
