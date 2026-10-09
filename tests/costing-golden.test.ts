import { describe, expect, it } from 'vitest';
import { cost } from '@/domain/costing';
import { goldenContext, goldenCosts, goldenState } from './helpers/golden';

describe('costing engine vs golden/costs.json (legacy oracle)', () => {
  const ctx = goldenContext();

  it('golden covers all 321 cards', () => {
    expect(goldenState.recipes).toHaveLength(321);
    expect(Object.keys(goldenCosts)).toHaveLength(321);
  });

  it('every field of cost() equals legacy exactly for all 321 cards', () => {
    let mismatches = 0;
    for (const r of goldenState.recipes) {
      const expected = goldenCosts[`${r.code}|${r.id}`];
      expect(expected, `${r.code} missing from golden`).toBeDefined();
      const actual = cost(r, ctx) as unknown as Record<string, unknown>;
      expect(Object.keys(actual).sort()).toEqual(Object.keys(expected!).sort());
      for (const k of Object.keys(expected!)) {
        if (!Object.is(actual[k], expected![k])) {
          mismatches++;
          expect.soft(actual[k], `${r.code} ${k}`).toBe(expected![k]);
        }
      }
    }
    expect(mismatches).toBe(0);
  });

  it('GRM-MN-0001 hand-checked sample (sp 108, food 29.63, fc 27.4%, net 24.37, suggest 98.76)', () => {
    const r = goldenState.recipes.find((x) => x.code === 'GRM-MN-0001')!;
    const c = cost(r, ctx);
    expect(c.sp).toBe(108);
    expect(c.food).toBeCloseTo(29.63, 2);
    expect(c.fcPct! * 100).toBeCloseTo(27.4, 1);
    expect(c.net).toBeCloseTo(24.37, 2);
    expect(c.suggest).toBeCloseTo(98.76, 2);
  });
});
