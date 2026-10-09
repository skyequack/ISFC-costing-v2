import { describe, expect, it } from 'vitest';
import { cost, type CostRecipe } from '@/domain/costing';
import { appendPriceCheck, PRICE_VARIANCE_THRESHOLD, priceMove } from '@/domain/ingredients';
import { byCostDesc, byQtyDesc, dayTotals, daysIn, pad2, ProdIndex, reqForDay, type ProdCard } from '@/domain/production/day';
import { goldenContext, goldenState } from './helpers/golden';

describe('price variance (D-43)', () => {
  it('threshold is 20%; exactly 20.0 is not flagged; beyond is; no old price / zero old price never produce a variance', () => {
    expect(PRICE_VARIANCE_THRESHOLD).toBe(0.2);
    expect(priceMove(10, 12)).toEqual({ pct: 0.2, check: false });
    expect(priceMove(10, 12.01).check).toBe(true);
    expect(priceMove(10, 7.9).check).toBe(true);
    expect(priceMove(10, 8).check).toBe(false);
    expect(priceMove(null, 5)).toEqual({ pct: null, check: false });
    expect(priceMove(0, 5)).toEqual({ pct: null, check: false });
    expect(priceMove(10, null)).toEqual({ pct: null, check: false });
    expect(priceMove(0.0064, 0.00768).check).toBe(false); // float noise at exactly +20%
    expect(priceMove(10, 11, 0.05).check).toBe(true); // threshold is a parameter
  });
  it('PRICE CHECK is appended once, existing flags kept verbatim', () => {
    expect(appendPriceCheck('')).toBe('PRICE CHECK');
    expect(appendPriceCheck('UNIT CHECK')).toBe('UNIT CHECK | PRICE CHECK');
    expect(appendPriceCheck('unit | price check')).toBe('unit | price check');
  });
});

describe('daily production arithmetic (D-20: all sites = every site + unassigned)', () => {
  const ctx = goldenContext();
  const recipes = goldenState.recipes.filter((r) => r.type === 'menu' && r.lines.length > 2).slice(0, 3);
  const [a, b] = recipes as [CostRecipe, CostRecipe];
  const idx = new ProdIndex([
    { day: '01', location: 'NIC', code: a.code, portions: 40 },
    { day: '01', location: 'NEOM', code: a.code, portions: 25 },
    { day: '01', location: '', code: a.code, portions: 5 },
    { day: '01', location: 'NIC', code: b.code, portions: 10 },
    { day: '02', location: 'NIC', code: b.code, portions: 7 },
    { day: '03', location: 'NIC', code: b.code, portions: 0 },
  ]);
  const cards: ProdCard[] = [a, b].map((r) => ({ recipe: r, food: cost(r, ctx).food, section: r === a ? 'hot' : 'sal', brandId: 'b' }));

  it('qty: one site, the unassigned bucket, or everything', () => {
    expect(idx.qty('01', a.code, 'NIC')).toBe(40);
    expect(idx.qty('01', a.code, '')).toBe(5);
    expect(idx.qty('01', a.code, '*')).toBe(70);
    expect(idx.qty('01', a.code, 'YANBU')).toBe(0);
    expect(idx.qty('09', a.code, '*')).toBe(0);
    expect(idx.qty('01', 'NOPE', '*')).toBe(0);
    expect(idx.bySite('01', a.code).sort()).toEqual([['', 5], ['NEOM', 25], ['NIC', 40]]);
    expect(idx.bySite('03', b.code)).toEqual([['NIC', 0]].filter(([, q]) => (q as number) > 0));
  });
  it('day totals add portions x cost per section; zero-portion cards are skipped', () => {
    const t = dayTotals(cards, idx, '01', '*');
    expect(t.portions).toBe(80);
    expect(t.sec['hot']).toBeCloseTo(70 * cards[0]!.food, 9);
    expect(t.sec['sal']).toBeCloseTo(10 * cards[1]!.food, 9);
    expect(t.total).toBeCloseTo(t.sec['hot']! + t.sec['sal']!, 9);
    expect(dayTotals(cards, idx, '03', '*')).toEqual({ sec: {}, total: 0, portions: 0 });
    expect(dayTotals(cards, idx, '01', 'NIC').portions).toBe(50);
  });
  it('requisition for the day: per recipe and consolidated agree; sorted helpers', () => {
    const req = { items: ctx.items, recipes: goldenState.recipes, conv: ctx.conv };
    const day = reqForDay(cards, idx, '01', '*', req);
    expect(Object.keys(day.bySec).sort()).toEqual(['hot', 'sal']);
    const all = Object.values(day.all);
    expect(all.length).toBeGreaterThan(0);
    const sumPer = Object.values(day.bySec).flat().reduce((n, x) => n + Object.values(x.per).reduce((m, e) => m + e.qty, 0), 0);
    expect(all.reduce((n, e) => n + e.qty, 0)).toBeCloseTo(sumPer, 6);
    const byCost = [...all].sort(byCostDesc);
    const byQty = [...all].sort(byQtyDesc);
    expect(byCost[0]!.cost).toBeGreaterThanOrEqual(byCost.at(-1)!.cost);
    expect(byQty[0]!.qty).toBeGreaterThanOrEqual(byQty.at(-1)!.qty);
    expect(reqForDay(cards, idx, '09', '*', req)).toEqual({ bySec: {}, all: {}, flags: [] });
  });
  it('calendar helpers', () => {
    expect(daysIn('2026-02')).toBe(28);
    expect(daysIn('2028-02')).toBe(29);
    expect(daysIn('2026-10')).toBe(31);
    expect(pad2(7)).toBe('07');
  });
});

describe('defensive branches', () => {
  it('a card whose per-portion cost is 0 or missing totals zero, bySite of an unknown day is empty', () => {
    const r = goldenState.recipes[0]!;
    const idx = new ProdIndex([{ day: '01', location: '', code: r.code, portions: 3 }]);
    const zero = dayTotals([{ recipe: r, food: 0, section: 'hot', brandId: 'b' }], idx, '01', '*');
    expect(zero).toEqual({ sec: { hot: 0 }, total: 0, portions: 3 });
    const nan = dayTotals([{ recipe: r, food: Number.NaN, section: 'hot', brandId: 'b' }], idx, '01', '*');
    expect(nan.total).toBe(0);
    expect(idx.bySite('09', r.code)).toEqual([]);
  });
});
