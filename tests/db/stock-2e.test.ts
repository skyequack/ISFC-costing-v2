import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import { makeScope } from '@/lib/db/scope';
import { ApiError } from '@/lib/errors';
import { dbHealthRows } from '@/lib/screens/health';
import { applyRestore, backupSchema, buildBackupCore, buildStockChunk } from '@/lib/services/backup';
import { updateBrand } from '@/lib/services/brands';
import { connect, hasTestDb, inRollback, insertIngredient, insertRecipe } from './helpers';

vi.mock('@/lib/db/catalog-cache', () => ({ getCatalog: vi.fn(), CATALOG_TAG: 'catalog' }));

const gm: SessionUser = { id: 'u-gm', clerkUserId: 'c-gm', email: null, name: 'T gm', role: 'gm' };

async function fail(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected an ApiError');
}

describe.skipIf(!hasTestDb)(
  'stock in backup, site rename and Data Health (D-75, D-76, D-83)',
  { timeout: 280_000 },
  () => {
    let c: pg.Client;
    beforeAll(async () => {
      c = await connect();
    }, 60_000);
    afterAll(async () => {
      await c.end();
    });

    const brand = async (code: string, locations: string[]) =>
      (
        await c.query(
          `INSERT INTO brand (legacy_id, code, name, locations) VALUES ($1,$1,$1,$2::text[]) RETURNING id`,
          [code, locations],
        )
      ).rows[0]!.id as string;
    const count = (site: string, date: string, code: string, qty: number) =>
      c.query('INSERT INTO stock_count (site, count_date, code, qty) VALUES ($1,$2,$3,$4)', [site, date, code, qty]);
    const receipt = (site: string, date: string, code: string, qty: number, ref = '') =>
      c.query('INSERT INTO receipt (site, receipt_date, code, qty, ref) VALUES ($1,$2,$3,$4,$5)', [
        site,
        date,
        code,
        qty,
        ref,
      ]);
    const n = async (sql: string, v: unknown[] = []) => Number((await c.query(sql, v)).rows[0]!.n);
    const dayAgo = async (d: number) =>
      (await c.query(`SELECT to_char(current_date - $1::int, 'YYYY-MM-DD') AS d`, [d])).rows[0]!.d as string;

    it('backup carries the last 13 months and a restore replaces that window only; unknown sites/codes are skipped; no stock = untouched', () =>
      inRollback(c, async () => {
        const b = await brand('ZE', ['ZE-S']);
        await insertIngredient(c, 'ZE-ING', 2);
        await insertRecipe(c, b, 'ZE-1');
        const recent = await dayAgo(3);
        const stray = await dayAgo(5);
        await count('ZE-S', recent, 'ZE-ING', 7);
        await count('ZE-S', '2020-01-01', 'ZE-ING', 99); // older than the window: never in the file, never touched
        await receipt('ZE-S', recent, 'ZE-ING', 4);
        await receipt('ZE-S', recent, 'ZE-ING', 6, 'file:abc');

        const core = await buildBackupCore(c, gm);
        expect(core.stockFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const counts = (await buildStockChunk(c, gm, 'counts', core.stockFrom!, 0)).items;
        const receipts = (await buildStockChunk(c, gm, 'receipts', core.stockFrom!, 0)).items;
        expect(counts).toEqual([{ site: 'ZE-S', date: recent, code: 'ZE-ING', qty: 7 }]);
        expect(receipts).toHaveLength(2);
        expect(receipts).toContainEqual({ site: 'ZE-S', date: recent, code: 'ZE-ING', qty: 6, ref: 'file:abc' });

        const slim = {
          ...core,
          ingredients: core.ingredients.filter((i) => i.code === 'ZE-ING'),
          recipes: core.recipes.filter((r) => r.code === 'ZE-1'),
          menus: [],
          menuPax: [],
          production: [],
        };
        const file = {
          ...slim,
          stockCounts: [
            ...(counts as { site: string; date: string; code: string; qty: number }[]),
            { site: 'NOWHERE', date: recent, code: 'ZE-ING', qty: 1 }, // no brand lists it
            { site: 'ZE-S', date: recent, code: 'NOT-AN-ING', qty: 1 }, // not an ingredient
          ],
          receipts,
        };
        expect(backupSchema.safeParse(JSON.parse(JSON.stringify(file))).success).toBe(true);

        // the database drifts: the count is changed, a stray in-window count appears
        await c.query('UPDATE stock_count SET qty = 1 WHERE count_date = $1', [recent]);
        await count('ZE-S', stray, 'ZE-ING', 5);
        await c.query(`DELETE FROM receipt WHERE site = 'ZE-S'`);

        const stats = await applyRestore(c, gm, backupSchema.parse(JSON.parse(JSON.stringify(file))), 'w.json');
        expect(stats).toMatchObject({ stockCounts: 1, receipts: 2, stockSkipped: 2 });
        const rows = (
          await c.query(
            `SELECT to_char(count_date,'YYYY-MM-DD') AS d, qty FROM stock_count WHERE site='ZE-S' ORDER BY 1`,
          )
        ).rows;
        expect(rows).toEqual([
          { d: '2020-01-01', qty: 99 }, // older than stockFrom: left alone
          { d: recent, qty: 7 }, // restored
        ]); // the stray in-window row is gone
        expect(await n(`SELECT count(*) AS n FROM receipt WHERE site='ZE-S'`)).toBe(2);

        // a file with no stock at all leaves stock as it is
        const noStock = JSON.parse(JSON.stringify(slim)) as Record<string, unknown>;
        delete noStock.stockFrom;
        const stats2 = await applyRestore(c, gm, backupSchema.parse(noStock), 'old.json');
        expect(stats2).toMatchObject({ stockCounts: null, receipts: null, stockSkipped: 0 });
        expect(await n(`SELECT count(*) AS n FROM stock_count WHERE site='ZE-S'`)).toBe(2);
      }));

    it('a rename carries the stock; shared with another brand = 409; a clash = 409; removal with stock stays refused', () =>
      inRollback(c, async () => {
        const a = await brand('ZR', ['ZR-S', 'ZR-SHARED']);
        await brand('ZQ', ['ZR-SHARED']);
        await insertIngredient(c, 'ZR-ING', 1);
        await count('ZR-S', '2026-01-02', 'ZR-ING', 3);
        await receipt('ZR-S', '2026-01-02', 'ZR-ING', 2);
        await count('ZR-SHARED', '2026-01-02', 'ZR-ING', 9);

        const rename = (from: string, to: string, locs: string[]) =>
          updateBrand(c, gm, a, { locations: locs, renamedSites: [{ from, to }] });

        // shared: another brand still lists the old name
        const shared = await fail(rename('ZR-SHARED', 'ZR-NEW', ['ZR-S', 'ZR-NEW']));
        expect(shared.status).toBe(409);
        expect(shared.message).toContain('rename it there too');
        expect(shared.message).not.toContain('ZQ'); // never names the other brand

        // removal with stock is refused
        expect((await fail(updateBrand(c, gm, a, { locations: ['ZR-SHARED'] }))).status).toBe(409);

        // clash: rows already under the new name on the same date and code
        await count('ZR-S2', '2026-01-02', 'ZR-ING', 1);
        expect((await fail(rename('ZR-S', 'ZR-S2', ['ZR-S2', 'ZR-SHARED']))).message).toContain('merge it first');
        expect(await n(`SELECT count(*) AS n FROM stock_count WHERE site = 'ZR-S'`)).toBe(1); // nothing moved

        // a clean rename carries both tables
        await c.query(`DELETE FROM stock_count WHERE site = 'ZR-S2'`);
        await rename('ZR-S', 'ZR-S2', ['ZR-S2', 'ZR-SHARED']);
        expect(await n(`SELECT count(*) AS n FROM stock_count WHERE site = 'ZR-S2'`)).toBe(1);
        expect(await n(`SELECT count(*) AS n FROM receipt WHERE site = 'ZR-S2'`)).toBe(1);
        expect(await n(`SELECT count(*) AS n FROM stock_count WHERE site = 'ZR-S'`)).toBe(0);
      }));

    it('Data Health reports orphan clients for the caller, and stock at unknown sites/codes for the GM only', () =>
      inRollback(c, async () => {
        const b = await brand('ZH', ['ZH-S']);
        const other = await brand('ZG', ['ZG-S']);
        await insertIngredient(c, 'ZH-ING', 1);
        await insertRecipe(c, b, 'ZH-1');
        const client = (
          await c.query(`INSERT INTO client (brand_id, name) VALUES ($1,'Other brand client') RETURNING id`, [other])
        ).rows[0]!.id as string;
        const prod = (cl: string) =>
          c.query(
            `INSERT INTO production_entry (month, day, location, client_id, recipe_code, portions) VALUES ('2097-06','01','ZH-S',$1,'ZH-1',1)`,
            [cl],
          );
        await prod('gone-client');
        await prod(client); // a client of a different brand than the card
        await count('LOST-SITE', '2026-01-02', 'ZH-ING', 1);
        await receipt('ZH-S', '2026-01-02', 'LOST-CODE', 1);

        const scope = makeScope([b]);
        const asCaller = await dbHealthRows(c, scope, false);
        expect(asCaller).toHaveLength(1);
        expect(asCaller[0]).toMatchObject({ sev: 'HIGH', where: 'Production figures' });
        expect(asCaller[0]!.problem).toContain('2 rows');

        const asGm = await dbHealthRows(c, scope, true);
        expect(asGm.map((r) => r.problem)).toEqual(
          expect.arrayContaining([
            expect.stringContaining('LOST-SITE, a site no brand lists'),
            expect.stringContaining('LOST-CODE, which is not an ingredient'),
          ]),
        );
        // a brand that sees none of it gets no orphan row
        expect(await dbHealthRows(c, makeScope([other]), false)).toEqual([]);
      }));
  },
);
