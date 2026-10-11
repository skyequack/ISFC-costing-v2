import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import type { Role } from '@/lib/permissions';
import { loadCatalog } from '@/lib/db/catalog';
import { buildCtx } from '@/lib/screens/ctx';
import { recipeRows } from '@/lib/screens/rows';
import { visibleBrandIds } from '@/lib/db/scope';
import { dashRows, loadDashAnalytics, dashFilters } from '@/lib/services/dash';
import { loadProductionRange } from '@/lib/services/planning';
import { connect, hasTestDb, insertIngredient, insertRecipe } from './helpers';

const h = vi.hoisted(() => ({ client: null as unknown as import('pg').Client, session: null as unknown }));
vi.mock('@/lib/db/client', async (orig) => {
  const actual = await orig<typeof import('@/lib/db/client')>();
  return {
    ...actual,
    db: { query: (t: string, v?: unknown[]) => h.client.query(t, v) },
    withTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      await h.client.query('SAVEPOINT dx');
      try {
        const r = await fn(h.client);
        await h.client.query('RELEASE SAVEPOINT dx');
        return r;
      } catch (e) {
        await h.client.query('ROLLBACK TO SAVEPOINT dx');
        throw e;
      }
    },
  };
});
vi.mock('@/lib/auth/session', () => ({ getSession: async () => h.session }));
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));

const ctxOf = (kind = 'dash') => ({ params: Promise.resolve({ kind }) });

describe.skipIf(!hasTestDb)(
  'dashboard analytics: filters, scope, matrix, export (D-65…D-67)',
  { timeout: 280_000 },
  () => {
    let c: pg.Client;
    beforeAll(async () => {
      c = await connect();
      h.client = c;
    }, 60_000);
    afterAll(async () => {
      await c.end();
    });
    beforeEach(async () => {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.query('BEGIN');
    });

    async function mkUser(role: Role, brandIds: string[]): Promise<SessionUser> {
      const { rows } = await c.query(`INSERT INTO app_user (clerk_user_id, name) VALUES ($1,$2) RETURNING id`, [
        `clerk-${role}-${Math.random()}`,
        `T ${role}`,
      ]);
      for (const b of brandIds)
        await c.query('INSERT INTO user_brand_access (user_id, brand_id) VALUES ($1,$2)', [rows[0]!.id, b]);
      return { id: rows[0]!.id as string, clerkUserId: 'c', email: null, name: `T ${role}`, role };
    }
    const as = (u: SessionUser) => (h.session = { status: 'ok', user: u });

    /**
     * Two brands. XD (sites NIC, ZED) has four menu cards whose classes do not depend on the cost-settings buffer:
     * A/B cost ~2 per portion, C/D ~200, all sell at 1000; A and C are popular (100 portions), B and D are not (5).
     * => A star, B puzzle, C plowhorse, D dog. XE has one card with 999 portions that must never leak into XD figures.
     */
    async function fixture(brandName = 'XD') {
      const xd = (
        await c.query(
          `INSERT INTO brand (legacy_id, code, name, locations) VALUES ('XD','XD',$1,ARRAY['NIC','ZED']) RETURNING id`,
          [brandName],
        )
      ).rows[0]!.id as string;
      const xe = (
        await c.query(
          `INSERT INTO brand (legacy_id, code, name, locations) VALUES ('XE','XE','XE',ARRAY['OTH']) RETURNING id`,
        )
      ).rows[0]!.id as string;
      await insertIngredient(c, 'XD-ING', 2);
      const cards: [string, number][] = [
        ['XD-A', 1],
        ['XD-B', 1],
        ['XD-C', 100],
        ['XD-D', 100],
      ];
      for (const [code, qty] of cards) {
        const id = await insertRecipe(c, xd, code);
        await c.query(`UPDATE recipe SET selling_price = 1000 WHERE id = $1`, [id]);
        await c.query(
          `INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit) VALUES ($1,1,'XD-ING',$2,'Gram')`,
          [id, qty],
        );
      }
      const ide = await insertRecipe(c, xe, 'XE-A');
      await c.query(`UPDATE recipe SET selling_price = 10 WHERE id = $1`, [ide]);
      const prod = (month: string, day: string, loc: string, code: string, q: number) =>
        c.query(`INSERT INTO production_entry (month, day, location, recipe_code, portions) VALUES ($1,$2,$3,$4,$5)`, [
          month,
          day,
          loc,
          code,
          q,
        ]);
      await prod('2098-04', '10', 'NIC', 'XD-A', 100);
      await prod('2098-04', '30', 'ZED', 'XD-B', 5);
      await prod('2098-05', '01', 'NIC', 'XD-C', 100);
      await prod('2098-04', '31', '', 'XD-D', 5); // production accepts day 31 in any month
      await prod('2098-04', '10', 'OTH', 'XE-A', 999);
      return { xd, xe };
    }

    const F = (o: object) => dashFilters.parse(o);
    async function load(user: SessionUser, f: object) {
      return loadDashAnalytics(c, await buildCtx(c, user), await loadCatalog(c), F(f));
    }

    it('date range is day-level and inclusive; sites and brands narrow; the other brand never leaks in', async () => {
      const gm = await mkUser('gm', []);
      // other data may exist on this branch for the same date, so compare with a baseline read first
      const base = (await load(gm, { brand: '*', from: '2098-04-10', to: '2098-04-10' })).portions;
      const { xd } = await fixture();
      const q = (o: object) => load(gm, { brand: xd, ...o });
      expect((await q({})).portions).toBe(100 + 5 + 100 + 5);
      expect((await q({ from: '2098-04-10', to: '2098-04-10' })).portions).toBe(100); // both ends inclusive
      // production accepts day 31 in a 30-day month; it counts as the 30th, so a whole-month range keeps it
      expect((await q({ from: '2098-04-01', to: '2098-04-30' })).portions).toBe(110);
      expect((await q({ from: '2098-04-30', to: '2098-04-30' })).portions).toBe(5 + 5);
      expect((await q({ from: '2098-05-01' })).portions).toBe(100); // and it is not in May
      expect((await q({ from: '2098-04-11' })).portions).toBe(5 + 100 + 5); // open end
      expect((await q({ to: '2098-04-09' })).portions).toBe(0);
      expect((await q({ loc: 'NIC' })).portions).toBe(200);
      expect((await q({ loc: 'ZED' })).portions).toBe(5);
      expect((await load(gm, { brand: '*', from: '2098-04-10', to: '2098-04-10' })).portions).toBe(base + 100 + 999);
    });

    it('Menu Matrix classes over exactly the filtered rows (hand-checked) and counts what it leaves out', async () => {
      const { xd } = await fixture();
      const gm = await mkUser('gm', []);
      const a = await load(gm, { brand: xd });
      const cls = Object.fromEntries(a.matrix.points!.map((p) => [p.code, p.quadrant]));
      expect(cls).toEqual({ 'XD-A': 'star', 'XD-C': 'plowhorse', 'XD-B': 'puzzle', 'XD-D': 'dog' });
      expect(a.matrix.popularityCut).toBeCloseTo((0.7 * 210) / 4, 9);
      // a narrower range leaves too few items to classify
      const narrow = await load(gm, { brand: xd, from: '2098-04-01', to: '2098-04-30' });
      expect(narrow.matrix.points).toBeNull();
      expect(narrow.matrix.classified).toBe(3); // A, B and D (the 31st counts as the 30th)
      expect(narrow.matrix.noProduction).toBe(1); // only C
    });

    it('cost drivers, margin at risk and unpriced exposure come from the produced portions', async () => {
      const { xd } = await fixture();
      const gm = await mkUser('gm', []);
      const a = await load(gm, { brand: xd, loc: 'NIC' });
      expect(a.drivers.rows.map((r) => r.item.code)).toEqual(['XD-ING']);
      // XD-A 100 portions x 1 + XD-C 100 portions x 100 = 10100 grams at price 2 (issue value, no buffer)
      expect(a.drivers.rows[0]!.cost).toBeCloseTo(10100 * 2, 6);
      expect(a.drivers.rows[0]!.cls).toBe('A');
      expect(a.risk.total).toBe(0); // everything sells at 1000, far inside the target
      expect(a.unpriced.count).toBe(0);
      await c.query(`UPDATE ingredient SET price = NULL WHERE code = 'XD-ING'`);
      const np = await load(gm, { brand: xd, loc: 'NIC' });
      expect(np.unpriced.rows.map((r) => r.code).sort()).toEqual(['XD-A', 'XD-C']);
      expect(np.unpriced.portions).toBe(200);
    });

    it('loadProductionRange only ever reads inside the scope it is given', async () => {
      const { xd, xe } = await fixture();
      const cc = await mkUser('cc', [xd]);
      const scope = await visibleBrandIds(cc, c);
      const total = (await loadProductionRange(c, scope, null, null, null, null)).reduce((a, r) => a + r.portions, 0);
      expect(total).toBe(210);
      expect(await loadProductionRange(c, scope, xe, null, null, null)).toEqual([]); // a brand outside the scope reads nothing
      const gm = await visibleBrandIds(await mkUser('gm', []), c);
      expect((await loadProductionRange(c, gm, xe, null, null, null)).map((r) => r.code)).toEqual(['XE-A']);
    });

    it('a month or day that is not a valid date does not break the range query', async () => {
      const { xd } = await fixture();
      await c.query(
        "INSERT INTO production_entry (month, day, location, recipe_code, portions) VALUES ('bogus','01','','XD-A',1), ('2098-13','01','','XD-A',2)",
      );
      const gm = await mkUser('gm', []);
      const a = await load(gm, { brand: xd, from: '2098-04-01', to: '2098-04-30' });
      expect(a.portions).toBe(110);
    });

    it('brand scope: filters can only narrow; an out-of-scope brand or site is a 404 and nothing leaks', async () => {
      const { xd, xe } = await fixture();
      const cc = await mkUser('cc', [xd]);
      const all = await load(cc, {});
      expect(all.portions).toBe(210); // XE-A's 999 portions are invisible to this user
      expect(all.brandOptions.map((b) => b.id)).toEqual([xd]);
      await expect(load(cc, { brand: xe })).rejects.toMatchObject({ code: 'not_found' });
      await expect(load(cc, { loc: 'OTH' })).rejects.toMatchObject({ code: 'not_found' }); // a site of another brand
      await expect(load(cc, { loc: 'NOPE' })).rejects.toMatchObject({ code: 'not_found' });
      const nobody = await mkUser('cc', []);
      const none = await load(nobody, {});
      expect(none.portions).toBe(0);
      expect(none.matrix.points).toBeNull();
    });

    it('with no filters the cost sections read exactly the rows the old dashboard read', async () => {
      await fixture();
      const gm = await mkUser('gm', []);
      const ctx = await buildCtx(c, gm);
      const catalog = await loadCatalog(c);
      expect(dashRows(catalog, ctx, '*')).toEqual(recipeRows(catalog, ctx.scope));
    });

    describe('export (kind dash)', () => {
      const get = async (qs = '') => {
        const { GET } = await import('@/app/api/export/[kind]/route');
        return GET(new Request(`http://x/api/export/dash${qs}`), ctxOf());
      };
      const exported = async (u: SessionUser) =>
        (
          await c.query(
            `SELECT detail FROM audit_log WHERE action = 'Exported data' AND user_id = $1 ORDER BY created_at`,
            [u.id],
          )
        ).rows.map((r) => r.detail as string);

      it('writes the filter echo and the same figures as the screen, audited once; formula text is neutralised', async () => {
        const { xd } = await fixture('=EVIL');
        const gm = await mkUser('gm', []);
        as(gm);
        const res = await get(`?brand=${xd}&from=2098-04-01&to=2098-05-31`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-disposition')).toContain('dashboard-2098-04-01_2098-05-31.csv');
        const lines = (await res.text()).split('\n');
        expect(lines[0]).toBe('Dashboard analytics');
        expect(lines[1]).toBe("Brand,'=EVIL"); // the brand name echoed in the filters is a formula starter
        expect(lines[3]).toBe('From,2098-04-01');
        expect(lines[5]).toBe('Portions in range,210');
        expect(lines.find((l) => l.startsWith('XD-A,') && l.endsWith(',Star'))).toBeTruthy();
        const log = await exported(gm);
        expect(log).toHaveLength(1);
        // the audited count is the data rows (4 matrix cards + 1 cost driver), not the title/filter/section lines
        expect(log[0]).toBe('dash: 5 rows');
      });

      it('a bad range is 400, an out-of-scope brand 404, and neither writes an audit row', async () => {
        const { xd, xe } = await fixture();
        const cc = await mkUser('cc', [xd]);
        as(cc);
        expect((await get('?from=2098-05-01&to=2098-04-01')).status).toBe(400);
        expect((await get('?from=2098-02-30')).status).toBe(400);
        expect((await get(`?brand=${xe}`)).status).toBe(404);
        expect((await get('?loc=OTH')).status).toBe(404);
        expect(await exported(cc)).toEqual([]);
        expect((await get(`?brand=${xd}`)).status).toBe(200);
        expect(await exported(cc)).toHaveLength(1);
      });
    });
  },
);
