import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import { loadReceipts, seesEveryBrandAt, visibleSites } from '@/lib/db/repo/stock';
import { visibleBrandIds } from '@/lib/db/scope';
import { ApiError } from '@/lib/errors';
import type { Role } from '@/lib/permissions';
import { loadStockGrid, saveStock } from '@/lib/services/stock';
import { connect, expectFails, hasTestDb, inRollback } from './helpers';

vi.mock('@/lib/db/catalog-cache', () => ({ getCatalog: vi.fn(), CATALOG_TAG: 'catalog' }));

async function fail(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected an ApiError');
}

describe.skipIf(!hasTestDb)('stock counts and receipts (D-72, D-73)', { timeout: 280_000 }, () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await connect();
  }, 60_000);
  afterAll(async () => {
    await c.end();
  });

  async function mkUser(role: Role, brandIds: string[] = []): Promise<SessionUser> {
    const { rows } = await c.query(`INSERT INTO app_user (clerk_user_id, name) VALUES ($1,$2) RETURNING id`, [
      `clerk-${role}-${Math.random()}`,
      `T ${role}`,
    ]);
    for (const b of brandIds)
      await c.query('INSERT INTO user_brand_access (user_id, brand_id) VALUES ($1,$2)', [rows[0]!.id, b]);
    return { id: rows[0]!.id as string, clerkUserId: 'c', email: null, name: `T ${role}`, role };
  }
  const scopeOf = (u: SessionUser) => visibleBrandIds(u, c);

  /**
   * Two brands sharing the site ZS-SHARED; ZS-A is only brand A's, ZS-B only brand B's. Ingredients: ZS-SHARED-ING (any brand),
   * ZS-A-ING (brand A only), ZS-B-ING (brand B only).
   */
  async function fixture() {
    const brand = async (code: string, sites: string[]) =>
      (
        await c.query(
          `INSERT INTO brand (legacy_id, code, name, locations) VALUES ($1,$1,$1,$2::text[]) RETURNING id`,
          [code, sites],
        )
      ).rows[0]!.id as string;
    const a = await brand('ZSA', ['ZS-SHARED', 'ZS-A']);
    const b = await brand('ZSB', ['ZS-SHARED', 'ZS-B']);
    const ing = async (code: string, scope?: string) => {
      const id = (
        await c.query(
          `INSERT INTO ingredient (code, name, uom, price, category, subcategory) VALUES ($1,$1,'Gram',1,'c','s') RETURNING id`,
          [code],
        )
      ).rows[0]!.id as string;
      if (scope) await c.query('INSERT INTO item_brand_scope (ingredient_id, brand_id) VALUES ($1,$2)', [id, scope]);
    };
    await ing('ZS-SHARED-ING');
    await ing('ZS-A-ING', a);
    await ing('ZS-B-ING', b);
    return { a, b };
  }
  const put = (
    u: SessionUser,
    scope: Awaited<ReturnType<typeof scopeOf>>,
    over: Partial<{
      site: string;
      date: string;
      kind: 'count' | 'receipt';
      cells: { code: string; qty: number | null }[];
    }>,
  ) =>
    saveStock(c, u, scope, {
      site: 'ZS-A',
      date: '2025-06-10',
      kind: 'count',
      cells: [{ code: 'ZS-A-ING', qty: 4 }],
      ...over,
    });
  const counts = async () =>
    (await c.query(`SELECT site, code, qty FROM stock_count WHERE code LIKE 'ZS-%' ORDER BY site, code`)).rows.map(
      (r) => `${r.site}|${r.code}|${r.qty}`,
    );

  it('a user sees the sites of the brands in their scope; a shared site is visible to both, and "sees every brand" tells them apart', () =>
    inRollback(c, async () => {
      const { a, b } = await fixture();
      const gm = await mkUser('gm');
      const ua = await mkUser('cc', [a]);
      const nobody = await mkUser('cc');
      const mine = (await visibleSites(c, await scopeOf(ua))).filter((s) => s.startsWith('ZS-'));
      expect(mine).toEqual(['ZS-A', 'ZS-SHARED']);
      expect((await visibleSites(c, await scopeOf(gm))).filter((s) => s.startsWith('ZS-'))).toEqual([
        'ZS-A',
        'ZS-B',
        'ZS-SHARED',
      ]);
      expect(await visibleSites(c, await scopeOf(nobody))).toEqual([]);
      expect(await seesEveryBrandAt(c, await scopeOf(ua), 'ZS-A')).toBe(true);
      expect(await seesEveryBrandAt(c, await scopeOf(ua), 'ZS-SHARED')).toBe(false); // brand B also lists it
      expect(await seesEveryBrandAt(c, await scopeOf(gm), 'ZS-SHARED')).toBe(true);
      void b;
    }));

  it('the grid lists the ingredients in scope with the stored value or null; a site outside the scope is a 404', () =>
    inRollback(c, async () => {
      const { a } = await fixture();
      const ua = await mkUser('chef', [a]);
      const s = await scopeOf(ua);
      await put(ua, s, {
        cells: [
          { code: 'ZS-A-ING', qty: 4 },
          { code: 'ZS-SHARED-ING', qty: 0 },
        ],
      });
      const g = await loadStockGrid(c, s, { site: 'ZS-A', date: '2025-06-10', kind: 'count' });
      const mine = g.rows.filter((r) => r.code.startsWith('ZS-'));
      expect(mine.map((r) => [r.code, r.qty])).toEqual([
        ['ZS-A-ING', 4],
        ['ZS-SHARED-ING', 0], // counted empty is 0, not "not counted"
      ]); // brand B's ingredient is not offered
      expect(g.rows.length).toBeGreaterThan(mine.length); // the rest of the catalog is there too, with nothing stored
      expect(g.rows.find((r) => r.code !== 'ZS-A-ING' && !r.code.startsWith('ZS-'))!.qty).toBeNull();
      expect((await fail(loadStockGrid(c, s, { site: 'ZS-B', date: '2025-06-10', kind: 'count' }))).status).toBe(404);
      expect((await loadStockGrid(c, s, { site: '', date: '2025-06-10', kind: 'count' })).site).toBe(g.sites[0]); // '' = the first
      const none = await scopeOf(await mkUser('cc'));
      expect(await loadStockGrid(c, none, { site: '', date: '2025-06-10', kind: 'count' })).toMatchObject({
        sites: [],
        rows: [],
      });
    }));

  it('counts: every role but the viewer may save; a value is replaced, 0 is kept, null clears; one audit row without the values', () =>
    inRollback(c, async () => {
      const { a } = await fixture();
      for (const role of ['gm', 'cc', 'fin', 'chef', 'cook'] as const) {
        const u = await mkUser(role, [a]);
        await put(u, await scopeOf(u), { cells: [{ code: 'ZS-A-ING', qty: 1 }] });
      }
      const viewer = await mkUser('viewer', [a]);
      expect((await fail(put(viewer, await scopeOf(viewer), {}))).status).toBe(403);
      const u = await mkUser('chef', [a]);
      const s = await scopeOf(u);
      await put(u, s, { cells: [{ code: 'ZS-A-ING', qty: 7.5 }] });
      expect(await counts()).toEqual(['ZS-A|ZS-A-ING|7.5']); // one row, replaced
      await put(u, s, { cells: [{ code: 'ZS-A-ING', qty: 0 }] });
      expect(await counts()).toEqual(['ZS-A|ZS-A-ING|0']);
      const out = await put(u, s, {
        cells: [
          { code: 'ZS-A-ING', qty: null },
          { code: 'ZS-SHARED-ING', qty: 2 },
        ],
      });
      expect(out).toEqual({ saved: 1, cleared: 1 });
      expect(await counts()).toEqual(['ZS-A|ZS-SHARED-ING|2']);
      // one audit row per save, with counts only (a transaction gives every row the same timestamp, so match on the text)
      const audit = (
        await c.query("SELECT detail FROM audit_log WHERE action = 'Stock counts saved' AND detail LIKE 'ZS-A%'")
      ).rows.map((r) => r.detail);
      expect(audit).toContain('ZS-A · 2025-06-10: 1 saved, 1 cleared');
      expect(audit.join('|')).not.toMatch(/7.5|ZS-A-ING/); // never the quantities or codes
    }));

  it('nothing is written when any cell is refused: unknown or out-of-scope code, duplicate code, other brand site, future date', () =>
    inRollback(c, async () => {
      const { a } = await fixture();
      const u = await mkUser('chef', [a]);
      const s = await scopeOf(u);
      const good = { code: 'ZS-A-ING', qty: 5 };
      const e1 = await fail(put(u, s, { cells: [good, { code: 'ZS-B-ING', qty: 1 }] })); // brand B's own ingredient
      expect(e1.status).toBe(422);
      expect((await fail(put(u, s, { cells: [good, { code: 'NO-SUCH-CODE', qty: 1 }] }))).status).toBe(422);
      expect((await fail(put(u, s, { cells: [good, good] }))).status).toBe(400);
      expect((await fail(put(u, s, { site: 'ZS-B' }))).status).toBe(404); // a site of a brand the user cannot see
      expect((await fail(put(u, s, { site: 'NOWHERE' }))).status).toBe(404);
      expect((await fail(put(u, s, { date: '2999-01-01' }))).status).toBe(400);
      expect(await counts()).toEqual([]);
      expect(
        Number(
          (
            await c.query(
              `SELECT count(*) AS n FROM audit_log WHERE action = 'Stock counts saved' AND detail LIKE 'ZS-%'`,
            )
          ).rows[0]!.n,
        ),
      ).toBe(0);
    }));

  it('a shared site is open to the brands that list it: both write to the same shelf, each only with their own ingredients', () =>
    inRollback(c, async () => {
      const { a, b } = await fixture();
      const ua = await mkUser('chef', [a]);
      const ub = await mkUser('chef', [b]);
      await put(ua, await scopeOf(ua), {
        site: 'ZS-SHARED',
        cells: [
          { code: 'ZS-A-ING', qty: 1 },
          { code: 'ZS-SHARED-ING', qty: 9 },
        ],
      });
      await put(ub, await scopeOf(ub), {
        site: 'ZS-SHARED',
        cells: [
          { code: 'ZS-B-ING', qty: 2 },
          { code: 'ZS-SHARED-ING', qty: 8 },
        ],
      });
      expect(await counts()).toEqual(['ZS-SHARED|ZS-A-ING|1', 'ZS-SHARED|ZS-B-ING|2', 'ZS-SHARED|ZS-SHARED-ING|8']); // last write wins per cell
      expect(
        (await fail(put(ub, await scopeOf(ub), { site: 'ZS-SHARED', cells: [{ code: 'ZS-A-ING', qty: 5 }] }))).status,
      ).toBe(422);
    }));

  it('receipts: the grid row is replaced or cleared (0 clears), several uploaded deliveries are kept and shown as "other"', () =>
    inRollback(c, async () => {
      const { a } = await fixture();
      const u = await mkUser('cook', [a]);
      const s = await scopeOf(u);
      await c.query(
        `INSERT INTO receipt (site, receipt_date, code, qty, ref) VALUES ('ZS-A','2025-06-10','ZS-A-ING',5,'file1'), ('ZS-A','2025-06-10','ZS-A-ING',6,'file2')`,
      );
      await put(u, s, { kind: 'receipt', cells: [{ code: 'ZS-A-ING', qty: 3 }] });
      await put(u, s, { kind: 'receipt', cells: [{ code: 'ZS-A-ING', qty: 4 }] }); // replaces the grid row
      let r = (await loadReceipts(c, 'ZS-A', '2025-06-10')).get('ZS-A-ING')!;
      expect(r).toEqual({ qty: 4, other: 11 });
      const g = await loadStockGrid(c, s, { site: 'ZS-A', date: '2025-06-10', kind: 'receipt' });
      expect(g.rows.find((x) => x.code === 'ZS-A-ING')).toMatchObject({ qty: 4, other: 11 });
      await put(u, s, { kind: 'receipt', cells: [{ code: 'ZS-A-ING', qty: 0 }] });
      r = (await loadReceipts(c, 'ZS-A', '2025-06-10')).get('ZS-A-ING')!;
      expect(r.qty).toBeNull();
      expect(r.other).toBe(11); // the uploaded deliveries stay
      expect(Number((await c.query(`SELECT count(*) AS n FROM receipt WHERE code = 'ZS-A-ING'`)).rows[0]!.n)).toBe(2);
      expect((await c.query(`SELECT action FROM audit_log WHERE action = 'Receipts saved' LIMIT 1`)).rows).toHaveLength(
        1,
      );
    }));

  it('the table constraints hold even for a direct write: no negative quantity, no zero receipt, no duplicate key', () =>
    inRollback(c, async () => {
      await expectFails(
        c,
        "INSERT INTO stock_count (site, count_date, code, qty) VALUES ('s','2097-01-01','c',-1)",
        [],
        /check/i,
      );
      await expectFails(
        c,
        "INSERT INTO receipt (site, receipt_date, code, qty) VALUES ('s','2097-01-01','c',0)",
        [],
        /check/i,
      );
      await c.query("INSERT INTO stock_count (site, count_date, code, qty) VALUES ('s','2097-01-01','c',1)");
      await expectFails(
        c,
        "INSERT INTO stock_count (site, count_date, code, qty) VALUES ('s','2097-01-01','c',2)",
        [],
        /duplicate/i,
      );
      await c.query("INSERT INTO receipt (site, receipt_date, code, qty, ref) VALUES ('s','2097-01-01','c',1,'f')");
      await expectFails(
        c,
        "INSERT INTO receipt (site, receipt_date, code, qty, ref) VALUES ('s','2097-01-01','c',2,'f')",
        [],
        /duplicate/i,
      );
    }));
});
