import { describe, expect, it } from 'vitest';
import { stagedYield, validYield } from '@/domain/recipes/yield-stages';

describe('stagedYield (D-70, D-85)', () => {
  it('is null with no stage, else the product with a blank stage counting as 1', () => {
    expect(stagedYield({})).toBeNull();
    expect(stagedYield({ yThaw: null, yCut: null, yCook: null })).toBeNull();
    expect(stagedYield({ yCut: 0.5 })).toBe(0.5);
    expect(stagedYield({ yThaw: 0.9, yCut: 0.8, yCook: 0.5 })).toBe(0.9 * 0.8 * 0.5);
  });
  it('uses the costing range: above 0 and up to 10', () => {
    expect(validYield(10)).toBe(true);
    expect(validYield(0.0001)).toBe(true);
    expect(validYield(0)).toBe(false);
    expect(validYield(10.0001)).toBe(false);
    expect(validYield(Number.NaN)).toBe(false);
    expect(validYield(Infinity)).toBe(false);
  });
});
