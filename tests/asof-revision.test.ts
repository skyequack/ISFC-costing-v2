import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildContext, cost, type CostItem, type CostRecipe } from '@/domain/costing';
import {
  asOf,
  neverLocked,
  periodKey,
  pickRevision,
  type CardHistory,
  type ItemHistory,
  type Revision,
} from '@/domain/asof';

const settings = { pkg: 0, del: 0, lab: 0, ops: 0, buffer: 0, target: 0.3, vat: 0.15 };
const item = (code: string, price: number | null): CostItem => ({ code, name: code, uom: 'Gram', price });
const card = (
  code: string,
  type: 'menu' | 'sub',
  lines: { code: string; qty: number }[],
  over: Partial<CostRecipe> = {},
): CostRecipe => ({
  id: code,
  code,
  name: code,
  type,
  output: 1,
  subQty: type === 'sub' ? 100 : 0,
  subUom: 'Gram',
  batchOut: type === 'sub' ? 100 : 0,
  batchUom: 'Gram',
  price: 0,
  lines: lines.map((l) => ({ ...l, unit: 'Gram', y: 1, yp: 0 })),
  ...over,
});
const rev = (from: string, status: 'DRAFT' | 'LOCKED', recipe: CostRecipe): Revision => ({ from, status, recipe });
const food = (items: CostItem[], recipes: CostRecipe[], code: string) =>
  cost(
    recipes.find((r) => r.code === code)!,
    buildContext(items, recipes, [], settings),
  ).food;

describe('pickRevision (D-100, B3)', () => {
  const r = (n: number) => card('C', 'menu', [{ code: 'I', qty: n }]);
  const live = rev('2026-06-01', 'DRAFT', r(3));
  it('a card never approved is costed as it is today, for any day', () => {
    const revs = [rev('2026-01-01', 'DRAFT', r(1)), live];
    expect(pickRevision(revs, '2026-02-01')).toBe(live);
    expect(pickRevision(revs, '2000-01-01')).toBe(live);
    expect(neverLocked(revs)).toBe(true);
  });
  it('only approved revisions count: a draft live revision is ignored while an older approved one exists', () => {
    const l1 = rev('2026-01-01', 'LOCKED', r(1));
    const revs = [l1, rev('2026-03-01', 'DRAFT', r(2)), live];
    expect(pickRevision(revs, '2026-04-01')).toBe(l1);
    expect(pickRevision(revs, '2026-09-01')).toBe(l1);
    expect(neverLocked(revs)).toBe(false);
  });
  it('a revision counts from its start day (half-open), even if it was approved later', () => {
    const l1 = rev('2026-01-01', 'LOCKED', r(1));
    const l2 = rev('2026-03-01', 'LOCKED', r(2));
    const revs = [l1, l2, rev('2026-06-01', 'DRAFT', r(3))];
    expect(pickRevision(revs, '2026-02-28')).toBe(l1);
    expect(pickRevision(revs, '2026-03-01')).toBe(l2);
    expect(pickRevision(revs, '2026-12-31')).toBe(l2);
  });
  it('a day before the first approved revision uses the earliest approved one (never empty)', () => {
    const l1 = rev('2026-03-01', 'LOCKED', r(1));
    const revs = [rev('2026-01-01', 'DRAFT', r(0)), l1, rev('2026-05-01', 'DRAFT', r(2))];
    expect(pickRevision(revs, '2026-01-15')).toBe(l1);
  });
  it('an approved live revision applies from its start day on', () => {
    const l1 = rev('2026-01-01', 'LOCKED', r(1));
    const l2 = rev('2026-06-01', 'LOCKED', r(3));
    expect(pickRevision([l1, l2], '2026-06-01')).toBe(l2);
    expect(pickRevision([l1, l2], '2026-05-31')).toBe(l1);
  });
});

describe('asOf (D-100, B3): the unchanged engine, fed the catalog of a day', () => {
  const items = [item('I', 2)];
  const sub = card('S-1', 'sub', [{ code: 'I', qty: 100 }]);
  const parent = card('P-1', 'menu', [{ code: 'S-1', qty: 50 }]);
  const base = { items, recipes: [sub, parent] };

  it('with no history it is the same object, so every figure is exactly the current one', () => {
    expect(asOf(base, [], [], '2026-05-05')).toBe(base);
  });

  it('a parent follows its sub-recipe revision for the same day (the parent itself never changed)', () => {
    const oldSub = card('S-1', 'sub', [{ code: 'I', qty: 40 }]);
    const cards: CardHistory[] = [
      { code: 'S-1', liveFrom: '2026-06-01', liveStatus: 'LOCKED', archived: [rev('2026-01-01', 'LOCKED', oldSub)] },
    ];
    const before = asOf(base, cards, [], '2026-05-31');
    const after = asOf(base, cards, [], '2026-06-01');
    expect(food(before.items, before.recipes, 'P-1')).toBe(food(items, [oldSub, parent], 'P-1'));
    expect(food(after.items, after.recipes, 'P-1')).toBe(food(items, [sub, parent], 'P-1'));
    expect(food(before.items, before.recipes, 'P-1')).toBeLessThan(food(after.items, after.recipes, 'P-1'));
  });

  it('a sub-recipe changing inside a parent period, nested two deep', () => {
    const sub2 = card('S-2', 'sub', [{ code: 'S-1', qty: 10 }]);
    const b = { items, recipes: [sub, sub2, parent] };
    const oldSub = card('S-1', 'sub', [{ code: 'I', qty: 10 }]);
    const cards: CardHistory[] = [
      { code: 'S-1', liveFrom: '2026-03-01', liveStatus: 'LOCKED', archived: [rev('2026-01-01', 'LOCKED', oldSub)] },
    ];
    const a1 = asOf(b, cards, [], '2026-02-01');
    const a2 = asOf(b, cards, [], '2026-04-01');
    expect(food(a1.items, a1.recipes, 'S-2')).toBe(food(items, [oldSub, sub2], 'S-2'));
    expect(food(a2.items, a2.recipes, 'S-2')).toBe(food(items, [sub, sub2], 'S-2'));
  });

  it('prices by day: the card is costed with the price in force that day, and a missing price stays missing', () => {
    const its: ItemHistory[] = [{ code: 'I', points: [{ on: '2026-03-01', oldPrice: 1, newPrice: 2 }] }];
    expect(asOf(base, [], its, '2026-02-01').items[0]!.price).toBe(1);
    expect(asOf(base, [], its, '2026-03-01').items[0]!.price).toBe(2);
    const cleared: ItemHistory[] = [{ code: 'I', points: [{ on: '2026-03-01', oldPrice: 2, newPrice: null }] }];
    const none = asOf({ items: [item('I', null)], recipes: base.recipes }, [], cleared, '2026-04-01');
    expect(none.items[0]!.price).toBeNull();
  });

  it('periodKey: days that cost the same share a key, and the key changes exactly where a revision or price changes', () => {
    const cards: CardHistory[] = [
      {
        code: 'S-1',
        liveFrom: '2026-06-01',
        liveStatus: 'LOCKED',
        archived: [rev('2026-01-01', 'LOCKED', card('S-1', 'sub', [{ code: 'I', qty: 40 }]))],
      },
    ];
    const its: ItemHistory[] = [{ code: 'I', points: [{ on: '2026-03-01', oldPrice: 1, newPrice: 2 }] }];
    const k = (d: string) => periodKey(cards, its, d);
    expect(k('2026-01-05')).toBe(k('2026-02-28'));
    expect(k('2026-02-28')).not.toBe(k('2026-03-01'));
    expect(k('2026-03-01')).toBe(k('2026-05-31'));
    expect(k('2026-05-31')).not.toBe(k('2026-06-01'));
    expect(k('2026-06-01')).toBe(k('2026-12-31'));
  });

  it('property: a card whose revisions are all identical costs the same on every day', () => {
    const day = fc
      .integer({ min: 0, max: 300 })
      .map((n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10));
    fc.assert(
      fc.property(day, fc.constantFrom('DRAFT' as const, 'LOCKED' as const), (d, st) => {
        const cards: CardHistory[] = [
          { code: 'P-1', liveFrom: '2026-09-01', liveStatus: 'LOCKED', archived: [rev('2026-02-01', st, parent)] },
        ];
        const a = asOf(base, cards, [], d);
        expect(food(a.items, a.recipes, 'P-1')).toBe(food(items, base.recipes, 'P-1'));
      }),
    );
  });
});
