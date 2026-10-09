import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { assertAcyclic, assertAcyclicWith, CycleError, findCycle } from '@/domain/recipes/graph';
import { goldenState } from './helpers/golden';

const g = (code: string, ...refs: string[]) => ({ code, lines: refs.map((c) => ({ code: c })) });

describe('recipe graph', () => {
  it('golden data is acyclic', () => {
    expect(findCycle(goldenState.recipes)).toBeNull();
  });

  it('detects self reference, 2-cycles, long cycles', () => {
    expect(findCycle([g('A', 'A')])).toEqual(['A', 'A']);
    expect(findCycle([g('A', 'B'), g('B', 'A')])).toEqual(['A', 'B', 'A']);
    expect(findCycle([g('A', 'B'), g('B', 'C'), g('C', 'D'), g('D', 'B')])).toEqual(['B', 'C', 'D', 'B']);
  });

  it('is case-insensitive and ignores items / blank codes', () => {
    expect(findCycle([g('abc', 'ABC')])).not.toBeNull();
    expect(findCycle([g('A', 'ITEM-1', ''), g('B', 'A')])).toBeNull();
  });

  it('recipes sharing a code are one node: a cycle through the earlier duplicate is not hidden', () => {
    expect(findCycle([g('A', 'B'), g('a', 'C'), g('B', 'A'), g('C')])).not.toBeNull();
    expect(findCycle([g('B', 'A'), g('A', 'C'), g('a', 'B'), g('C')])).not.toBeNull();
  });

  it('diamonds are not cycles', () => {
    expect(findCycle([g('T', 'L', 'R'), g('L', 'B'), g('R', 'B'), g('B')])).toBeNull();
  });

  it('assertAcyclic throws CycleError carrying the path', () => {
    expect(() => assertAcyclic([g('A', 'B'), g('B', 'A')])).toThrow(CycleError);
  });

  it('assertAcyclicWith checks a prospective save (replacing by previous code on rename)', () => {
    const existing = [g('A', 'B'), g('B')];
    expect(() => assertAcyclicWith(existing, g('B', 'A'))).toThrow(CycleError);
    expect(() => assertAcyclicWith(existing, g('B', 'X'))).not.toThrow();
    expect(() => assertAcyclicWith(existing, g('B2', 'A'), 'B')).not.toThrow(); // A->B dangles until the D-33 cascade rewrites it
    expect(() => assertAcyclicWith([g('A', 'B2'), g('B', 'X')], g('B2', 'A'), 'B')).toThrow(CycleError); // after the cascade
  });

  it('handles a very deep chain without stack overflow', () => {
    const chain = Array.from({ length: 20000 }, (_, i) => g(`N${i}`, `N${i + 1}`));
    chain.push(g('N20000'));
    expect(findCycle(chain)).toBeNull();
    chain[20000] = g('N20000', 'N0');
    expect(findCycle(chain)).not.toBeNull();
  });

  it('property: a DAG built from a topological order is never reported cyclic; adding a back-edge always is', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 30 }),
        fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 80 }),
        (n, pairs) => {
          const lines: string[][] = Array.from({ length: n }, () => []);
          for (const [a, b] of pairs) {
            const i = a % n,
              j = b % n;
            if (i < j) lines[i]!.push(`N${j}`);
          }
          const recs = lines.map((ls, i) => g(`N${i}`, ...ls));
          expect(findCycle(recs)).toBeNull();
          // back edge from the last node reachable from 0? force: 0 -> n-1 -> 0
          const withCycle = recs.map((r, i) =>
            i === 0
              ? g(r.code, ...r.lines.map((l) => l.code), `N${n - 1}`)
              : i === n - 1
                ? g(r.code, ...r.lines.map((l) => l.code), 'N0')
                : r,
          );
          expect(findCycle(withCycle)).not.toBeNull();
        },
      ),
    );
  });
});
