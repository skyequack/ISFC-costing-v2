import { describe, expect, it } from 'vitest';
import { prefillStages } from '@/domain/recipes/yield-stages';
import { parseItemRows, parseStagePct, TPL_HEAD } from '@/lib/import/items';
import { ingredientIn, itemStageIn } from '@/lib/validation/common';

describe('raw material default stages: validation (D-93)', () => {
  it('0 and null become null (100%), a number in (0,10] is kept, absent stays absent', () => {
    expect(itemStageIn.parse(0)).toBeNull();
    expect(itemStageIn.parse(null)).toBeNull();
    expect(itemStageIn.parse(undefined)).toBeUndefined();
    expect(itemStageIn.parse(0.875)).toBe(0.875);
    expect(itemStageIn.parse(10)).toBe(10);
  });
  it('refuses negatives, above 10, NaN and Infinity', () => {
    for (const v of [-0.1, 10.01, Number.NaN, Infinity, '0.9', true])
      expect(itemStageIn.safeParse(v).success).toBe(false);
  });
  const base = { code: 'A', name: 'a', uom: 'Gram', price: 1 };
  it('an ingredient body without stages leaves them absent (an old client must not wipe the defaults)', () => {
    const o = ingredientIn.parse(base);
    expect(o.yThaw).toBeUndefined();
    expect(o.yCut).toBeUndefined();
    expect(o.yCook).toBeUndefined();
    expect(ingredientIn.parse({ ...base, yThaw: 0, yCut: null, yCook: 0.5 })).toMatchObject({
      yThaw: null,
      yCut: null,
      yCook: 0.5,
    });
    expect(ingredientIn.safeParse({ ...base, yCook: 11 }).success).toBe(false);
  });
});

describe('prefillStages (D-94)', () => {
  it('copies only the stages the item has and sets y to their product', () => {
    const r = prefillStages({ yThaw: 0.9, yCut: null, yCook: 0.5 }, { yThaw: null, yCut: null, yCook: null });
    expect(r).toEqual({ yThaw: 0.9, yCut: null, yCook: 0.5, y: 0.9 * 0.5 });
  });
  it('does nothing without a default, or on a line that already has a stage', () => {
    expect(prefillStages({ yThaw: null, yCut: null, yCook: null }, {})).toBeNull();
    expect(prefillStages({}, {})).toBeNull();
    expect(prefillStages({ yThaw: 0.9 }, { yCut: 0.8 })).toBeNull();
  });
  it('never replaces a yield typed by hand', () => {
    expect(prefillStages({ yThaw: 0.9 }, { y: 0.8 })).toBeNull();
    expect(prefillStages({ yThaw: 0.9 }, { y: 1 })).toMatchObject({ y: 0.9 });
  });
  it('does not produce a yield costing would not accept', () => {
    expect(prefillStages({ yThaw: 10, yCut: 10, yCook: 10 }, {})).toBeNull();
  });
});

describe('item import: yield columns (D-93)', () => {
  it('parseStagePct: blank = leave, 0 = clear, percent -> fraction, % sign allowed, junk is bad', () => {
    expect(parseStagePct('')).toBeUndefined();
    expect(parseStagePct('  ')).toBeUndefined();
    expect(parseStagePct('0')).toBeNull();
    expect(parseStagePct('90')).toBe(0.9);
    expect(parseStagePct('87.5%')).toBe(0.875);
    for (const t of ['abc', '-5', '1001', 'Infinity']) expect(parseStagePct(t)).toBe('bad');
  });
  const head = ['Code', 'Item Name', 'UOM', 'Price', ...TPL_HEAD.slice(4)];
  it('reads the three columns by header; a blank cell leaves the field out of the row', () => {
    const r = parseItemRows([head, ['X-1', 'Thing', 'Gram', '1', 'Cat', 'Sub', '90', '', '0']]);
    expect(r.rejected).toEqual([]);
    const it = r.items[0]!;
    expect(it.yThaw).toBe(0.9);
    expect('yCut' in it).toBe(false);
    expect(it.yCook).toBeNull();
  });
  it('a sheet without the columns carries no yields at all', () => {
    const r = parseItemRows([['X-1', 'Thing', 'Gram', '1.5', 'Cat', 'Sub']]);
    expect(r.items[0]).not.toHaveProperty('yThaw');
  });
  it('a bad yield rejects its row and names the column', () => {
    const r = parseItemRows([head, ['X-1', 'Thing', 'Gram', '1', 'C', 'S', 'abc', '', '']]);
    expect(r.items).toHaveLength(0);
    expect(r.rejected[0]).toContain('thawing %');
  });
});
