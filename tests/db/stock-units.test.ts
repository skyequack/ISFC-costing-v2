import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import { makeScope } from '@/lib/db/scope';
import { commitStockImport, previewStockImport } from '@/lib/services/import-stock';
import { loadStockGrid, saveStock } from '@/lib/services/stock';
import { connect, hasTestDb, inRollback } from './helpers';

vi.mock('@/lib/db/catalog-cache', () => ({ getCatalog: vi.fn(), CATALOG_TAG: 'catalog' }));

const gm: SessionUser = { id: 'u-gm', clerkUserId: 'c-gm', email: null, name: 'T gm', role: 'gm' };

describe.skipIf(!hasTestDb)('stock in the inventory unit (D-104)', { timeout: 280_000 }, () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await connect();
  }, 60_000);
  afterAll(async () => {
    await c.end();
  });

  /** One brand with the site ZU-S; ZU-TIN counted in cartons of 12 000 g, ZU-OIL in the base unit (never set). */
  async function fixture() {
    const brand = (
      await c.query(
        `INSERT INTO brand (legacy_id, code, name, locations) VALUES ('ZU','ZU','ZU','{ZU-S}') RETURNING id`,
      )
    ).rows[0]!.id as string;
    await c.query(
      `INSERT INTO ingredient (code, name, uom, price, category, subcategory, inventory_unit, inventory_factor)
       VALUES ('ZU-TIN','Tins','Gram',0.01,'c','s','Carton',12000)`,
    );
    await c.query(
      `INSERT INTO ingredient (code, name, uom, price, category, subcategory) VALUES ('ZU-OIL','Oil','Ml',0.02,'c','s')`,
    );
    return makeScope([brand]);
  }
  const base = async () =>
    Object.fromEntries(
      (await c.query(`SELECT code, qty FROM stock_count WHERE code LIKE 'ZU-%'`)).rows.map((r) => [r.code, r.qty]),
    );
  const row = async (scope: ReturnType<typeof makeScope>, code: string, kind: 'count' | 'receipt' = 'count') =>
    (await loadStockGrid(c, scope, { site: 'ZU-S', date: '2025-06-10', kind })).rows.find((r) => r.code === code)!;

  it('a count typed in cartons is stored in grams and read back in cartons', () =>
    inRollback(c, async () => {
      const scope = await fixture();
      expect(await row(scope, 'ZU-TIN')).toMatchObject({ uom: 'Carton', qty: null });
      expect(await row(scope, 'ZU-OIL')).toMatchObject({ uom: 'Ml', qty: null });
      await saveStock(c, gm, scope, {
        site: 'ZU-S',
        date: '2025-06-10',
        kind: 'count',
        cells: [
          { code: 'ZU-TIN', qty: 1.5 },
          { code: 'ZU-OIL', qty: 7 },
        ],
      });
      expect(await base()).toEqual({ 'ZU-TIN': 18000, 'ZU-OIL': 7 });
      expect(await row(scope, 'ZU-TIN')).toMatchObject({ uom: 'Carton', qty: 1.5 });
      expect(await row(scope, 'ZU-OIL')).toMatchObject({ uom: 'Ml', qty: 7 });
    }));

  it('a quantity stored before this feature (base units) shows in the new unit; receipts too', () =>
    inRollback(c, async () => {
      const scope = await fixture();
      await c.query(
        `INSERT INTO stock_count (site, count_date, code, qty, updated_by) VALUES ('ZU-S','2025-06-10','ZU-TIN',24000,'x')`,
      );
      await c.query(
        `INSERT INTO receipt (site, receipt_date, code, qty, ref, updated_by) VALUES ('ZU-S','2025-06-10','ZU-TIN',6000,'file:abc','x')`,
      );
      expect((await row(scope, 'ZU-TIN')).qty).toBe(2);
      expect(await row(scope, 'ZU-TIN', 'receipt')).toMatchObject({ qty: null, other: 0.5 });
    }));

  it('an upload is in the inventory unit: it is compared with the stored count in base units and written in base units', () =>
    inRollback(c, async () => {
      const scope = await fixture();
      await c.query(
        `INSERT INTO stock_count (site, count_date, code, qty, updated_by) VALUES ('ZU-S','2025-06-10','ZU-TIN',18000,'x')`,
      );
      const input = (qty: number) => ({
        kind: 'count' as const,
        rows: [{ site: 'ZU-S', date: '2025-06-10', code: 'ZU-TIN', qty, line: 2 }],
        file: 'f.xlsx',
      });
      const same = await previewStockImport(c, gm, scope, input(1.5));
      expect(same.counts).toMatchObject({ same: 1, update: 0 });
      const upd = await previewStockImport(c, gm, scope, input(2));
      expect(upd.counts).toMatchObject({ update: 1 });
      expect(upd.sample[0]).toMatchObject({ old: 1.5, qty: 2 }); // both in cartons
      await commitStockImport(c, gm, scope, { ...input(2), hash: upd.hash });
      expect((await base())['ZU-TIN']).toBe(24000);
    }));
});
