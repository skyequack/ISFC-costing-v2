import { describe, expect, it } from 'vitest';
import { parseItemRows, TPL_HEAD } from '@/lib/import/items';
import { fitUnit, fromBase, PACK_FACTOR_MAX, PACK_FACTOR_MIN, toBase, type UnitDef } from '@/lib/units';

const U = (code: string, kind: UnitDef['kind'], toBase: number | null): UnitDef => ({ code, kind, toBase });
const kg = U('Kg', 'mass', 1000);
const litre = U('L', 'volume', 1000);
const carton = U('Carton', 'pack', null);

describe('fitUnit (D-102)', () => {
  it('a unit equal to the base unit is always factor 1, whatever was typed', () => {
    expect(fitUnit(U('Gram', 'mass', 1), 'Gram', 7)).toEqual({ ok: true, factor: 1 });
    expect(fitUnit(U('gram', 'mass', 1), 'Gram', null)).toEqual({ ok: true, factor: 1 });
  });

  it('a fixed unit takes the table factor and ignores the typed one', () => {
    expect(fitUnit(kg, 'Gram', 3)).toEqual({ ok: true, factor: 1000 });
    expect(fitUnit(litre, 'Ml', undefined)).toEqual({ ok: true, factor: 1000 });
  });

  it('never mixes weight, volume and count (no density is guessed)', () => {
    for (const [unit, uom] of [
      [kg, 'Ml'],
      [kg, 'Each'],
      [litre, 'Gram'],
      [litre, 'Slice'],
      [U('Each', 'each', 1), 'Slice'],
      [U('Slice', 'slice', 1), 'Each'],
    ] as const)
      expect(fitUnit(unit, uom, 1).ok, `${unit.code} on ${uom}`).toBe(false);
  });

  it('a pack unit needs a finite factor inside the bounds', () => {
    expect(fitUnit(carton, 'Gram', 12000)).toEqual({ ok: true, factor: 12000 });
    expect(fitUnit(carton, 'Each', PACK_FACTOR_MIN)).toEqual({ ok: true, factor: PACK_FACTOR_MIN });
    expect(fitUnit(carton, 'Each', PACK_FACTOR_MAX)).toEqual({ ok: true, factor: PACK_FACTOR_MAX });
    for (const bad of [0, -1, NaN, Infinity, -Infinity, PACK_FACTOR_MIN / 2, PACK_FACTOR_MAX * 2, null, undefined])
      expect(fitUnit(carton, 'Gram', bad as number).ok, String(bad)).toBe(false);
  });
});

describe('toBase / fromBase', () => {
  it('factor 1 is the exact identity', () => {
    for (const q of [0, 1, 0.1 + 0.2, 1234.5678, 1e-9]) {
      expect(toBase(q, 1)).toBe(q);
      expect(fromBase(q, 1)).toBe(q);
    }
  });

  it('round-trips within 1e-12 for awkward factors', () => {
    for (const f of [1 / 3, 0.001, 1000, 12000, 7.25])
      for (const q of [0.5, 1, 13.37, 250]) expect(Math.abs(fromBase(toBase(q, f), f) - q) / q).toBeLessThan(1e-12);
  });

  it('a carton of 12 000 g counted as 1.5 is exactly 18 000 g', () => {
    expect(toBase(1.5, 12000)).toBe(18000);
  });
});

describe('price-list parsing of the unit columns (D-102, D-105)', () => {
  const head = ['Code', 'Item Name', 'UOM', 'Price', 'Buying Unit', 'Buying Qty', 'Counting Unit', 'Counting Qty'];

  it('reads the four columns; a Purchase Unit header stays the base unit column', () => {
    const r = parseItemRows([head, ['A-1', 'Tins', 'Gram', '0.01', 'Carton', '12,000', 'Kg', '']]);
    expect(r.rejected).toEqual([]);
    expect(r.items[0]).toMatchObject({ purchaseUnit: 'Carton', purchaseFactor: 12000, inventoryUnit: 'Kg' });
    expect(r.items[0]).not.toHaveProperty('inventoryFactor');
    const legacy = parseItemRows([
      ['Code', 'Item Name', 'Purchase Unit', 'Price'],
      ['A-2', 'Salt', 'Gram', '0.001'],
    ]);
    expect(legacy.items[0]).toMatchObject({ uom: 'Gram' });
    expect(legacy.items[0]).not.toHaveProperty('purchaseUnit');
  });

  it('blank cells leave the units alone; a bad quantity rejects the row', () => {
    const r = parseItemRows([
      head,
      ['A-3', 'Salt', 'Gram', '', '', '', '', ''],
      ['A-4', 'Oil', 'Ml', '1', 'Bag', 'abc', '', ''],
      ['A-5', 'Oil', 'Ml', '1', 'Bag', '-3', '', ''],
    ]);
    expect(r.items.map((i) => i.code)).toEqual(['A-3']);
    expect(r.items[0]).not.toHaveProperty('purchaseUnit');
    expect(r.rejected).toHaveLength(2);
  });

  it('the template carries the four columns after the yields', () => {
    expect(TPL_HEAD.slice(-4)).toEqual(['Buying Unit', 'Buying Qty', 'Counting Unit', 'Counting Qty']);
  });
});
