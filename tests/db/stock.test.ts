import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import { loadReceipts, visibleSites } from '@/lib/db/repo/stock';
import { visibleBrandIds } from '@/lib/db/scope';
import { ApiError } from '@/lib/errors';
import type { Role } from '@/lib/permissions';
import { updateBrand } from '@/lib/services/brands';
import {
  commitStockImport,
  previewStockImport,
  receiptRef,
  undoReceiptUpload,
  type StockImportIn,
} from '@/lib/services/import-stock';
import { loadStockGrid, saveStock } from '@/lib/services/stock';
import { connect, expectFails, hasTestDb, inRollback } from './helpers';

vi.mock('@/lib/db/catalog-cache', () => ({ getCatalog: vi.fn(), CATALOG_TAG: 'catalog' }));
const h = vi.hoisted(() => ({ client: null as unknown as import('pg').Client, session: null as unknown }));
vi.mock('@/lib/db/client', async (orig) => {
  const actual = await orig<typeof import('@/lib/db/client')>();
  return {
    ...actual,
    db: { query: (t: string, v?: unknown[]) => h.client.query(t, v) },
    withTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      await h.client.query('SAVEPOINT stk');
      try {
        const r = await fn(h.client);
        await h.client.query('RELEASE SAVEPOINT stk');
        return r;
      } catch (e) {
        await h.client.query('ROLLBACK TO SAVEPOINT stk');
        throw e;
      }
    },
  };
});
vi.mock('@/lib/auth/session', () => ({ getSession: async () => h.session }));
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));

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
    h.client = c;
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

  it('a user sees the sites of the brands in their scope; a shared site is visible to both', () =>
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

  it('clearing what was never stored writes nothing and no audit row; the count is of rows really deleted', () =>
    inRollback(c, async () => {
      const { a } = await fixture();
      const u = await mkUser('chef', [a]);
      const s = await scopeOf(u);
      const before = Number(
        (
          await c.query(
            "SELECT count(*) AS n FROM audit_log WHERE action = 'Stock counts saved' AND detail LIKE 'ZS-A%'",
          )
        ).rows[0]!.n,
      );
      expect(await put(u, s, { cells: [{ code: 'ZS-A-ING', qty: null }] })).toEqual({ saved: 0, cleared: 0 });
      expect(
        Number(
          (
            await c.query(
              "SELECT count(*) AS n FROM audit_log WHERE action = 'Stock counts saved' AND detail LIKE 'ZS-A%'",
            )
          ).rows[0]!.n,
        ),
      ).toBe(before);
      await put(u, s, { cells: [{ code: 'ZS-A-ING', qty: 2 }] });
      expect(
        await put(u, s, {
          cells: [
            { code: 'ZS-A-ING', qty: null },
            { code: 'ZS-SHARED-ING', qty: null },
          ],
        }),
      ).toEqual({ saved: 0, cleared: 1 });
    }));

  it('stock follows a site rename (D-76); removing a site that has stock is refused; one without stock can go', () =>
    inRollback(c, async () => {
      const { a } = await fixture();
      const gm = await mkUser('gm');
      await put(gm, await scopeOf(gm), { cells: [{ code: 'ZS-A-ING', qty: 1 }] });
      const rename = (from: string, to: string) =>
        updateBrand(c, gm, a, { locations: ['ZS-SHARED', to], renamedSites: [{ from, to }] });
      await rename('ZS-A', 'ZS-A2');
      expect((await c.query('SELECT locations FROM brand WHERE id = $1', [a])).rows[0]!.locations).toEqual([
        'ZS-SHARED',
        'ZS-A2',
      ]);
      expect(Number((await c.query("SELECT count(*) AS n FROM stock_count WHERE site = 'ZS-A2'")).rows[0]!.n)).toBe(1);
      expect(Number((await c.query("SELECT count(*) AS n FROM stock_count WHERE site = 'ZS-A'")).rows[0]!.n)).toBe(0);
      expect((await fail(updateBrand(c, gm, a, { locations: ['ZS-SHARED'] }))).status).toBe(409); // removal
      await c.query("DELETE FROM stock_count WHERE site = 'ZS-A2'");
      await updateBrand(c, gm, a, { locations: ['ZS-SHARED'] });
      expect((await c.query('SELECT locations FROM brand WHERE id = $1', [a])).rows[0]!.locations).toEqual([
        'ZS-SHARED',
      ]);
    }));

  describe('PUT /api/stock', () => {
    const call = async (u: SessionUser, body: unknown) => {
      h.session = { status: 'ok', user: u };
      const { PUT } = await import('@/app/api/stock/route');
      return PUT(
        new Request('http://x/api/stock', {
          method: 'PUT',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }),
        { params: Promise.resolve({}) },
      );
    };
    const body = { site: 'ZS-A', date: '2025-06-10', kind: 'count', cells: [{ code: 'ZS-A-ING', qty: 3 }] };

    it('a chef saves, a viewer is refused (403), a bad body is 400, an unknown site 404, a foreign ingredient 422', () =>
      inRollback(c, async () => {
        const { a } = await fixture();
        const chef = await mkUser('chef', [a]);
        const viewer = await mkUser('viewer', [a]);
        const ok = await call(chef, body);
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual({ saved: 1, cleared: 0 });
        expect(await counts()).toEqual(['ZS-A|ZS-A-ING|3']);
        expect((await call(viewer, { ...body, cells: [{ code: 'ZS-A-ING', qty: 9 }] })).status).toBe(403);
        expect(await counts()).toEqual(['ZS-A|ZS-A-ING|3']);
        expect((await call(chef, { ...body, date: '2025-02-30' })).status).toBe(400);
        expect((await call(chef, { ...body, cells: [{ code: 'ZS-A-ING', qty: -1 }] })).status).toBe(400);
        expect((await call(chef, { ...body, site: 'ZS-B' })).status).toBe(404);
        expect((await call(chef, { ...body, cells: [{ code: 'ZS-B-ING', qty: 1 }] })).status).toBe(422);
      }));
  });

  describe('upload (slice 2c, D-73)', () => {
    const D = '2025-06-10';
    const file = (kind: 'count' | 'receipt', rows: [string, string, number][], date = D): StockImportIn => ({
      kind,
      file: 'f.csv',
      rows: rows.map(([site, code, qty], i) => ({ site, date, code, qty, line: i + 2 })),
    });
    const receipts = async () =>
      (
        await c.query("SELECT site, code, qty, ref FROM receipt WHERE code LIKE 'ZS-%' ORDER BY site, code, qty")
      ).rows.map((r) => r.site + '|' + r.code + '|' + r.qty + '|' + (r.ref === '' ? 'grid' : 'file'));

    it('counts: the dry-run writes nothing and plans add / update / same; the commit loads it; the same file again changes nothing', () =>
      inRollback(c, async () => {
        const { a } = await fixture();
        const u = await mkUser('cook', [a]);
        const s = await scopeOf(u);
        await put(u, s, { cells: [{ code: 'ZS-A-ING', qty: 5 }] });
        const f1 = file('count', [
          ['ZS-A', 'ZS-A-ING', 5],
          ['ZS-A', 'ZS-SHARED-ING', 3],
        ]);
        const plan = await previewStockImport(c, u, s, f1);
        expect(plan.counts).toEqual({ add: 1, update: 0, same: 1, blocked: 0 });
        expect(plan.sample.map((p) => [p.code, p.action, p.old, p.qty])).toEqual([['ZS-SHARED-ING', 'add', null, 3]]);
        expect(await counts()).toEqual(['ZS-A|ZS-A-ING|5']); // nothing written by the check
        expect(await commitStockImport(c, u, s, { ...f1, hash: plan.hash })).toEqual({ added: 1, updated: 0, same: 1 });
        expect(await counts()).toEqual(['ZS-A|ZS-A-ING|5', 'ZS-A|ZS-SHARED-ING|3']);
        // a changed value is an update that shows what it replaces
        const f2 = file('count', [['ZS-A', 'ZS-A-ING', 6]]);
        const p2 = await previewStockImport(c, u, s, f2);
        expect(p2.sample[0]).toMatchObject({ action: 'update', old: 5, qty: 6 });
        await commitStockImport(c, u, s, { ...f2, hash: p2.hash });
        // loading the identical file again is harmless: every row is "same", nothing is written
        const p3 = await previewStockImport(c, u, s, f2);
        expect(p3.counts).toMatchObject({ add: 0, update: 0, same: 1 });
        expect(await commitStockImport(c, u, s, { ...f2, hash: p3.hash })).toEqual({ added: 0, updated: 0, same: 1 });
        const audit = (await c.query("SELECT detail FROM audit_log WHERE action = 'Uploaded stock counts'")).rows.map(
          (r) => r.detail as string,
        );
        expect(
          audit.some((d) =>
            d.startsWith('f.csv (' + plan.hash.slice(0, 12) + '): 1 added, 0 updated, 1 unchanged · ZS-A · ' + D),
          ),
        ).toBe(true);
        expect(audit.join('|')).not.toMatch(/ZS-A-ING|ZS-SHARED-ING/); // codes and quantities stay out of the log
      }));

    it('a file is loaded whole or not at all: a hash that does not match is 409, any blocked row is 422 and nothing is written', () =>
      inRollback(c, async () => {
        const { a } = await fixture();
        const u = await mkUser('chef', [a]);
        const s = await scopeOf(u);
        const good = file('count', [['ZS-A', 'ZS-A-ING', 1]]);
        const p = await previewStockImport(c, u, s, good);
        expect((await fail(commitStockImport(c, u, s, good))).status).toBe(409); // no hash
        expect((await fail(commitStockImport(c, u, s, { ...good, hash: 'x'.repeat(64) }))).status).toBe(409);
        const edited = { ...good, rows: [{ ...good.rows[0]!, qty: 2 }], hash: p.hash }; // changed after the check
        expect((await fail(commitStockImport(c, u, s, edited))).status).toBe(409);
        const bad = file('count', [
          ['ZS-A', 'ZS-A-ING', 1], // fine
          ['NOWHERE', 'ZS-A-ING', 1], // unknown site
          ['ZS-B', 'ZS-A-ING', 1], // a site of a brand the user cannot see
          ['ZS-A', 'ZS-B-ING', 1], // another brand's ingredient
          ['ZS-A', 'NO-SUCH', 1], // not in the catalog
          ['ZS-A', 'ZS-SHARED-ING', 1],
          ['ZS-A', 'ZS-SHARED-ING', 2], // the same site, day and code twice
        ]);
        const pb = await previewStockImport(c, u, s, bad);
        expect(pb.counts.blocked).toBe(5);
        expect(pb.blocked.map((b) => b.reason)).toEqual([
          'not one of your sites',
          'not one of your sites',
          'not an ingredient you can use',
          'not an ingredient you can use',
          'appears twice in the file for the same site and date',
        ]);
        expect((await fail(commitStockImport(c, u, s, { ...bad, hash: pb.hash }))).status).toBe(422);
        const future = file('count', [['ZS-A', 'ZS-A-ING', 1]], '2999-01-01');
        expect((await previewStockImport(c, u, s, future)).blocked[0]!.reason).toBe('the date is in the future');
        expect(await counts()).toEqual([]); // the one good row of the bad file was not loaded either
      }));

    it('receipts: each row is one delivery under the file ref, the grid row is untouched, and the same file cannot be loaded twice', () =>
      inRollback(c, async () => {
        const { a } = await fixture();
        const u = await mkUser('fin', [a]);
        const s = await scopeOf(u);
        await put(u, s, { kind: 'receipt', cells: [{ code: 'ZS-A-ING', qty: 4 }] }); // typed in the grid
        const f1 = file('receipt', [
          ['ZS-A', 'ZS-A-ING', 6],
          ['ZS-A', 'ZS-SHARED-ING', 2],
        ]);
        const p1 = await previewStockImport(c, u, s, f1);
        expect(p1.counts).toMatchObject({ add: 2, blocked: 0 });
        expect(p1.alreadyImported).toBe(false);
        expect(await commitStockImport(c, u, s, { ...f1, hash: p1.hash })).toMatchObject({ added: 2 });
        expect(await receipts()).toEqual(['ZS-A|ZS-A-ING|4|grid', 'ZS-A|ZS-A-ING|6|file', 'ZS-A|ZS-SHARED-ING|2|file']);
        expect((await c.query("SELECT ref FROM receipt WHERE code = 'ZS-SHARED-ING'")).rows[0]!.ref).toBe(
          receiptRef(p1.hash),
        );
        const g = await loadStockGrid(c, s, { site: 'ZS-A', date: D, kind: 'receipt' });
        expect(g.rows.find((r) => r.code === 'ZS-A-ING')).toMatchObject({ qty: 4, other: 6 });
        // the very same content again (even under another name) is refused, so a double click never doubles the deliveries
        const again = { ...f1, file: 'copy-of-f.csv' };
        const p2 = await previewStockImport(c, u, s, again);
        expect(p2.alreadyImported).toBe(true);
        expect((await fail(commitStockImport(c, u, s, { ...again, hash: p2.hash }))).status).toBe(409);
        // a different file is a different upload; a delivery of 0 is not a delivery
        const f3 = file('receipt', [['ZS-A', 'ZS-A-ING', 1]]);
        expect((await previewStockImport(c, u, s, f3)).alreadyImported).toBe(false);
        const zero = file('receipt', [['ZS-A', 'ZS-A-ING', 0]]);
        expect((await previewStockImport(c, u, s, zero)).blocked[0]!.reason).toBe('a delivery must be more than 0');
        expect(Number((await c.query("SELECT count(*) AS n FROM receipt WHERE code LIKE 'ZS-%'")).rows[0]!.n)).toBe(3);
      }));

    it('a blocked row never reveals the name of an ingredient the user may not use; one they may use keeps its name', () =>
      inRollback(c, async () => {
        const { a } = await fixture();
        const u = await mkUser('chef', [a]);
        const s = await scopeOf(u);
        const p = await previewStockImport(
          c,
          u,
          s,
          file('count', [
            ['ZS-A', 'ZS-B-ING', 1], // brand B's ingredient: exists, but not for this user
            ['ZS-A', 'NO-SUCH', 1],
            ['ZS-A', 'ZS-SHARED-ING', 1],
            ['ZS-A', 'ZS-SHARED-ING', 2], // blocked as a duplicate, an ingredient the user may use
          ]),
        );
        const byCode = new Map(p.blocked.map((b) => [b.code + '|' + b.line, b.name]));
        expect(byCode.get('ZS-B-ING|2')).toBe('');
        expect(byCode.get('NO-SUCH|3')).toBe('');
        expect(byCode.get('ZS-SHARED-ING|5')).toBe('ZS-SHARED-ING');
        expect(JSON.stringify(p)).not.toContain('"name":"ZS-B-ING"');
      }));

    it('undo takes back exactly one receipts upload at the sites the user can see, leaves grid deliveries alone, and is audited', () =>
      inRollback(c, async () => {
        const { a, b } = await fixture();
        const ua = await mkUser('cc', [a]);
        const ub = await mkUser('cc', [b]);
        const sa = await scopeOf(ua);
        await put(ua, sa, { kind: 'receipt', cells: [{ code: 'ZS-A-ING', qty: 4 }] }); // grid delivery
        const f1 = file('receipt', [
          ['ZS-A', 'ZS-A-ING', 6],
          ['ZS-SHARED', 'ZS-SHARED-ING', 2],
        ]);
        const p1 = await previewStockImport(c, ua, sa, f1);
        await commitStockImport(c, ua, sa, { ...f1, hash: p1.hash });
        const f2 = file('receipt', [['ZS-A', 'ZS-A-ING', 9]]);
        const p2 = await previewStockImport(c, ua, sa, f2);
        await commitStockImport(c, ua, sa, { ...f2, hash: p2.hash });
        expect((await receipts()).length).toBe(4);
        // a user of brand B can see ZS-SHARED but not ZS-A: undoing A's upload removes only the shared-site row
        expect(await undoReceiptUpload(c, ub, await scopeOf(ub), { hash: p1.hash })).toEqual({ removed: 1 });
        expect(await receipts()).toEqual(['ZS-A|ZS-A-ING|4|grid', 'ZS-A|ZS-A-ING|6|file', 'ZS-A|ZS-A-ING|9|file']);
        expect(await undoReceiptUpload(c, ua, sa, { hash: p1.hash })).toEqual({ removed: 1 });
        expect(await receipts()).toEqual(['ZS-A|ZS-A-ING|4|grid', 'ZS-A|ZS-A-ING|9|file']); // the other upload and the grid row stay
        expect((await fail(undoReceiptUpload(c, ua, sa, { hash: p1.hash }))).status).toBe(404); // nothing left
        // the same content can be loaded again once it was undone
        expect((await previewStockImport(c, ua, sa, f1)).alreadyImported).toBe(false);
        const viewer = await mkUser('viewer', [a]);
        expect((await fail(undoReceiptUpload(c, viewer, await scopeOf(viewer), { hash: p2.hash }))).status).toBe(403);
        const audit = (await c.query("SELECT detail FROM audit_log WHERE action = 'Undid a receipts upload'")).rows.map(
          (r) => r.detail,
        );
        expect(audit).toContain(p1.hash.slice(0, 12) + ': 1 deliveries removed');
      }));

    it('a viewer may not upload, and a user without sites finds every row blocked', () =>
      inRollback(c, async () => {
        const { a } = await fixture();
        const viewer = await mkUser('viewer', [a]);
        const f1 = file('count', [['ZS-A', 'ZS-A-ING', 1]]);
        expect((await fail(previewStockImport(c, viewer, await scopeOf(viewer), f1))).status).toBe(403);
        expect((await fail(commitStockImport(c, viewer, await scopeOf(viewer), { ...f1, hash: 'x' }))).status).toBe(
          403,
        );
        const nobody = await mkUser('chef');
        expect((await previewStockImport(c, nobody, await scopeOf(nobody), f1)).counts.blocked).toBe(1);
      }));

    it('POST /api/stock/import: dry-run then commit through the route; a bad mode or body is 400; the viewer is 403', () =>
      inRollback(c, async () => {
        const { a } = await fixture();
        const chef = await mkUser('chef', [a]);
        const viewer = await mkUser('viewer', [a]);
        const post = async (u: SessionUser, mode: string, body: unknown) => {
          h.session = { status: 'ok', user: u };
          const { POST } = await import('@/app/api/stock/import/route');
          return POST(
            new Request('http://x/api/stock/import?mode=' + mode, {
              method: 'POST',
              body: JSON.stringify(body),
              headers: { 'content-type': 'application/json' },
            }),
            { params: Promise.resolve({}) },
          );
        };
        const f1 = file('count', [['ZS-A', 'ZS-A-ING', 8]]);
        const dry = await post(chef, 'dry-run', f1);
        expect(dry.status).toBe(200);
        const plan = (await dry.json()) as { hash: string; counts: { add: number } };
        expect(plan.counts.add).toBe(1);
        expect(await counts()).toEqual([]);
        const done = await post(chef, 'commit', { ...f1, hash: plan.hash });
        expect(done.status).toBe(200);
        expect(await done.json()).toEqual({ added: 1, updated: 0, same: 0 });
        expect(await counts()).toEqual(['ZS-A|ZS-A-ING|8']);
        expect((await post(chef, 'load', f1)).status).toBe(400);
        expect((await post(chef, 'dry-run', { ...f1, rows: [] })).status).toBe(400);
        expect((await post(chef, 'dry-run', { ...f1, rows: [{ ...f1.rows[0]!, qty: -2 }] })).status).toBe(400);
        expect((await post(viewer, 'dry-run', f1)).status).toBe(403);
      }));
  });

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
