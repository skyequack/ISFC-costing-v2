import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { priceOnDate, type PricePoint } from '@/domain/asof/price';

const P = (on: string, oldPrice: number | null, newPrice: number | null): PricePoint => ({ on, oldPrice, newPrice });

describe('priceOnDate (D-100, B2)', () => {
  it('no history: the current price, and a missing price stays missing (never 0)', () => {
    expect(priceOnDate([], 4.5, '2026-10-01')).toBe(4.5);
    expect(priceOnDate([], null, '2026-10-01')).toBeNull();
  });

  const h = [P('2026-03-01', 1, 2), P('2026-06-01', 2, 3)];
  it('before the first change: the price it replaced', () => {
    expect(priceOnDate(h, 3, '2026-02-28')).toBe(1);
  });
  it('the day of a change takes the new price (half-open: the old price ends the day before)', () => {
    expect(priceOnDate(h, 3, '2026-03-01')).toBe(2);
    expect(priceOnDate(h, 3, '2026-05-31')).toBe(2);
    expect(priceOnDate(h, 3, '2026-06-01')).toBe(3);
  });
  it('on or after the last change: the live price', () => {
    expect(priceOnDate(h, 3.5, '2027-01-01')).toBe(3.5);
  });
  it('an item first priced later: before that day the earliest known price (its first price)', () => {
    const first = [P('2026-05-10', null, 7)];
    expect(priceOnDate(first, 7, '2026-01-01')).toBe(7);
    expect(priceOnDate(first, 7, '2026-05-10')).toBe(7);
  });
  it('a price cleared to null stays null from that day, and a price before it is not turned into 0', () => {
    const cleared = [P('2026-03-01', 5, null), P('2026-08-01', null, 6)];
    expect(priceOnDate(cleared, 6, '2026-02-01')).toBe(5);
    expect(priceOnDate(cleared, 6, '2026-04-01')).toBeNull();
    expect(priceOnDate(cleared, 6, '2026-08-01')).toBe(6);
  });
  it('several changes on one day: the last one written wins for the whole day', () => {
    const day = [P('2026-03-01', 1, 2), P('2026-03-01', 2, 9), P('2026-07-01', 9, 4)];
    expect(priceOnDate(day, 4, '2026-03-01')).toBe(9);
    expect(priceOnDate(day, 4, '2026-06-30')).toBe(9);
  });
  it('the first price ever being null with no old price: nothing known, null', () => {
    expect(priceOnDate([P('2026-03-01', null, null)], null, '2026-01-01')).toBeNull();
  });

  it('property: a day on or after every change always gives the live price; a day before every change never gives a later price', () => {
    const day = fc
      .integer({ min: 0, max: 400 })
      .map((n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10));
    const price = fc.option(fc.double({ min: 0, max: 1000, noNaN: true }), { nil: null });
    fc.assert(
      fc.property(fc.array(fc.tuple(day, price, price), { minLength: 1, maxLength: 8 }), price, (rows, current) => {
        const pts = rows.map(([on, o, n]) => P(on, o, n)).sort((a, b) => a.on.localeCompare(b.on));
        const last = pts[pts.length - 1]!.on;
        expect(priceOnDate(pts, current, last)).toBe(current);
        const first = pts[0]!;
        const before = new Date(Date.parse(first.on) - 86_400_000).toISOString().slice(0, 10);
        expect(priceOnDate(pts, current, before)).toBe(first.oldPrice !== null ? first.oldPrice : first.newPrice);
      }),
    );
  });
});
