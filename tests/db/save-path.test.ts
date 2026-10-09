import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import type { Queryable } from '@/lib/db/client';
import { getRecipe } from '@/lib/db/repo/recipes';
import { makeScope } from '@/lib/db/scope';
import { createIngredient } from '@/lib/services/ingredients';
import { createRecipe, saveRecipe } from '@/lib/services/recipes';
import { connect, hasTestDb, inRollback, insertBrand } from './helpers';

const gm: SessionUser = { id: 'u-gm', clerkUserId: 'c-gm', email: null, name: 'T gm', role: 'gm' };
const line = (code: string, qty: number, extra: Record<string, unknown> = {}) => ({
  code,
  qty,
  unit: 'Gram' as const,
  y: 1,
  yp: null,
  ...extra,
});

/** Records every statement a service sends, so tests can assert what the save path does and does not run. */
function spy(c: pg.Client): { q: Queryable; sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    q: {
      query: ((text: string, values?: unknown[]) => {
        sql.push(text);
        return c.query(text, values);
      }) as Queryable['query'],
    },
  };
}
const lockCalls = (sql: string[]) => sql.filter((s) => s.includes('pg_advisory_xact_lock')).length;

describe.skipIf(!hasTestDb)(
  'save path: single load, conditional graph lock, one audit statement',
  { timeout: 120_000 },
  () => {
    let c: pg.Client;
    beforeAll(async () => {
      c = await connect();
    }, 60_000);
    afterAll(async () => {
      await c.end();
    });

    async function world() {
      const brand = await insertBrand(c, 'ZZ');
      const scope = makeScope([brand]);
      await createIngredient(c, gm, scope, {
        code: 'TSTI',
        name: 'Test item',
        uom: 'Gram',
        price: 2,
        category: 'c',
        subcategory: 's',
        flag: '',
        brandIds: [],
      });
      return { brand, scope };
    }

    it('lines and steps read in one statement round-trip exactly: re-saving identical awkward doubles is a no-op', () =>
      inRollback(c, async () => {
        const { brand, scope } = await world();
        const id = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
        const lines = [
          line('TSTI', 0.1 + 0.2),
          line('TSTI', 1 / 3, { y: 0.85, yp: 0 }),
          line('TSTI', 1234567.891011, { yp: 12.5 }),
          line('', 0),
        ];
        const method = ['Grill – 5 min', 'Rest ½ h', ''];
        await saveRecipe(c, gm, scope, id, { version: 0, lines, method });
        const again = await saveRecipe(c, gm, scope, id, { version: 1, lines, method });
        expect(again.changed).toBe(false);
        const r = await getRecipe(c, scope, id);
        expect(r.lines.map((l) => l.qty)).toEqual([0.1 + 0.2, 1 / 3, 1234567.891011, 0]);
        expect(r.lines.map((l) => l.yp)).toEqual([null, 0, 12.5, null]);
        expect(r.method).toEqual(method);
      }));

    it('a name-only save takes no graph lock; lines, code and type/brand changes still do', () =>
      inRollback(c, async () => {
        const { brand, scope } = await world();
        const id = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
        let s = spy(c);
        await saveRecipe(s.q, gm, scope, id, { version: 0, name: 'A', category: 'B', output: 2, buffer: 0.1 });
        expect(lockCalls(s.sql)).toBe(0);
        s = spy(c);
        await saveRecipe(s.q, gm, scope, id, { version: 1, method: ['x'] });
        expect(lockCalls(s.sql)).toBe(0);
        s = spy(c);
        await saveRecipe(s.q, gm, scope, id, { version: 2, lines: [line('TSTI', 5)] });
        expect(lockCalls(s.sql)).toBe(1);
        s = spy(c);
        await saveRecipe(s.q, gm, scope, id, { version: 3, code: 'ZZ-CUSTOM-1' });
        expect(lockCalls(s.sql)).toBe(1);
        s = spy(c);
        await saveRecipe(s.q, gm, scope, id, { version: 4, type: 'SUB' });
        expect(lockCalls(s.sql)).toBeGreaterThanOrEqual(1);
      }));

    it('a name-only save is load + update + one audit statement (no separate dedupe select)', () =>
      inRollback(c, async () => {
        const { brand, scope } = await world();
        const id = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
        const s = spy(c);
        await saveRecipe(s.q, gm, scope, id, { version: 0, name: 'Only a name' });
        expect(s.sql).toHaveLength(3);
        expect(s.sql[0]).toMatch(/FOR UPDATE OF r/);
        expect(s.sql[1]).toMatch(/^UPDATE recipe/);
        expect(s.sql[2]).toMatch(/INSERT INTO audit_log/);
      }));

    it('audit: price + yield + rename + edit write four rows; autosave edits collapse per user and card within 10 minutes', () =>
      inRollback(c, async () => {
        const { brand, scope } = await world();
        const id = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
        await saveRecipe(c, gm, scope, id, { version: 0, lines: [line('TSTI', 5, { yp: 5 })] });
        const count = async (action: string) =>
          (await c.query(`SELECT count(*)::int AS n FROM audit_log WHERE user_id = 'u-gm' AND action = $1`, [action]))
            .rows[0].n as number;
        const actions = ['Changed a line yield', 'Changed sales price', 'Edited card', 'Renamed card code'];
        const before = await Promise.all(actions.map(count));
        // the rename changes the label, so this save's 'Edited card' row is not collapsed into the earlier one
        await saveRecipe(c, gm, scope, id, {
          version: 1,
          code: 'ZZ-REN-1',
          name: 'Renamed',
          sellingPrice: 9,
          lines: [line('TSTI', 5, { yp: 7 })],
        });
        const after = await Promise.all(actions.map(count));
        expect(after.map((n, i) => n - before[i]!)).toEqual([1, 1, 1, 1]);

        const edited = async () =>
          (await c.query(`SELECT count(*)::int AS n FROM audit_log WHERE user_id = 'u-gm' AND action = 'Edited card'`))
            .rows[0].n as number;
        const n0 = await edited();
        await saveRecipe(c, gm, scope, id, { version: 2, name: 'Again' });
        expect(await edited()).toBe(n0); // collapsed: same user, same card, within 10 minutes
      }));

    it('audit collapse treats % and _ in a code literally (A_B does not collapse with AXB)', () =>
      inRollback(c, async () => {
        const { brand, scope } = await world();
        const a = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
        const b = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
        await saveRecipe(c, gm, scope, a, { version: 0, code: 'AXB' });
        await saveRecipe(c, gm, scope, a, { version: 1, name: 'first' });
        await saveRecipe(c, gm, scope, b, { version: 0, code: 'A_B' });
        await saveRecipe(c, gm, scope, b, { version: 1, name: 'second' });
        const n = (
          await c.query(
            `SELECT count(*)::int AS n FROM audit_log WHERE user_id = 'u-gm' AND action = 'Edited card' AND (detail LIKE 'AXB %' OR detail LIKE 'A\\_B %')`,
          )
        ).rows[0].n as number;
        expect(n).toBe(2);
      }));
  },
);
