import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { priceOnDate, type PricePoint } from '@/domain/asof/price';
import type { SessionUser } from '@/lib/auth/types';
import { applyRestore, backupSchema, buildBackupCore } from '@/lib/services/backup';
import { makeScope } from '@/lib/db/scope';
import { addPriceHistory, createIngredient, updateIngredient } from '@/lib/services/ingredients';
import { connect, hasTestDb, inRollback, insertBrand } from './helpers';

vi.mock('@/lib/db/catalog-cache', () => ({ getCatalog: vi.fn(), CATALOG_TAG: 'catalog' }));

const gm: SessionUser = { id: 'u-gm', clerkUserId: 'c-gm', email: null, name: 'T gm', role: 'gm' };

describe.skipIf(!hasTestDb)(
  'dated ingredient prices (D-100, B2) against the database (all rolled back)',
  { timeout: 120_000 },
  () => {
    let c: pg.Client;
    beforeAll(async () => {
      c = await connect();
    }, 60_000);
    afterAll(async () => {
      await c.end();
    });

    const today = async () =>
      (await c.query(`SELECT ((now() AT TIME ZONE 'Asia/Riyadh')::date)::text AS d`)).rows[0]!.d as string;
    const newItem = async (code: string, price: number | null) =>
      (
        await c.query(
          `INSERT INTO ingredient (code, name, uom, price, category, subcategory, flag) VALUES ($1, 'Dated item', 'Gram', $2, 'c', 's', '') RETURNING id`,
          [code, price],
        )
      ).rows[0]!.id as string;
    const points = async (id: string): Promise<PricePoint[]> =>
      (
        await c.query(
          `SELECT effective_on::text AS d, old_price, new_price FROM ingredient_price_history WHERE ingredient_id = $1 ORDER BY effective_on, created_at, id`,
          [id],
        )
      ).rows.map((r) => ({
        on: r.d as string,
        oldPrice: r.old_price as number | null,
        newPrice: r.new_price as number | null,
      }));

    it('every row has a day: new rows get today in Asia/Riyadh, and the column is not null', () =>
      inRollback(c, async () => {
        const id = await newItem('DTP1', 2);
        await addPriceHistory(c, gm, id, null, 2, 'MANUAL');
        expect((await points(id))[0]!.on).toBe(await today());
        const bad = await c.query('SELECT count(*)::int AS n FROM ingredient_price_history WHERE effective_on IS NULL');
        expect(bad.rows[0]!.n).toBe(0);
      }));

    it('the real writers date their rows today: create, then a price edit, and the history reads back through priceOnDate', () =>
      inRollback(c, async () => {
        const scope = makeScope([await insertBrand(c, 'ZP')]);
        const id = (await createIngredient(c, gm, scope, {
          code: 'DTW1',
          name: 'Writer item',
          uom: 'Gram',
          price: 2,
          category: 'c',
          subcategory: 's',
          flag: '',
          brandIds: [],
        })) as string;
        await updateIngredient(c, gm, scope, id, {
          code: 'DTW1',
          name: 'Writer item',
          uom: 'Gram',
          price: 3.5,
          category: 'c',
          subcategory: 's',
          flag: '',
          brandIds: [],
          version: 0,
        });
        // one test transaction gives both rows the same created_at; real edits are separate transactions
        await c.query(
          "UPDATE ingredient_price_history SET created_at = created_at - interval '1 second' WHERE ingredient_id = $1 AND old_price IS NULL",
          [id],
        );
        const pts = await points(id);
        expect(pts).toEqual([
          { on: await today(), oldPrice: null, newPrice: 2 },
          { on: await today(), oldPrice: 2, newPrice: 3.5 },
        ]);
        expect(priceOnDate(pts, 3.5, await today())).toBe(3.5);
        expect(priceOnDate(pts, 3.5, '2000-01-01')).toBe(2); // before any record: the earliest known (the first price it had)
      }));

    it('the day follows the Riyadh business day, not the UTC day (21:00 to 24:00 UTC is already tomorrow there)', () =>
      inRollback(c, async () => {
        const r = await c.query(
          `SELECT ((TIMESTAMPTZ '2026-10-13 22:30:00+00' AT TIME ZONE 'Asia/Riyadh')::date)::text AS riyadh, ((TIMESTAMPTZ '2026-10-13 22:30:00+00' AT TIME ZONE 'UTC')::date)::text AS utc`,
        );
        expect(r.rows[0]).toEqual({ riyadh: '2026-10-14', utc: '2026-10-13' });
      }));

    it('rows written in order give the price on any day through priceOnDate, with the live price after the last change', () =>
      inRollback(c, async () => {
        const id = await newItem('DTP2', 3);
        await c.query(
          `INSERT INTO ingredient_price_history (ingredient_id, old_price, new_price, source, user_name_snapshot, effective_on, created_at) VALUES
           ($1, NULL, 1, 'MANUAL', 'x', '2026-01-10', '2026-01-10 08:00+03'),
           ($1, 1, 2, 'MANUAL', 'x', '2026-03-01', '2026-03-01 08:00+03'),
           ($1, 2, 2.5, 'MANUAL', 'x', '2026-03-01', '2026-03-01 09:00+03'),
           ($1, 2.5, 3, 'MANUAL', 'x', '2026-06-01', '2026-06-01 08:00+03')`,
          [id],
        );
        const pts = await points(id);
        expect(priceOnDate(pts, 3, '2026-01-05')).toBe(1); // before the first row: the first price it ever had
        expect(priceOnDate(pts, 3, '2026-02-01')).toBe(1);
        expect(priceOnDate(pts, 3, '2026-03-01')).toBe(2.5); // two changes that day: the last written wins
        expect(priceOnDate(pts, 3, '2026-05-31')).toBe(2.5);
        expect(priceOnDate(pts, 3, '2026-06-01')).toBe(3);
      }));

    it('a restore that changes a price leaves a RESTORE history row; an unchanged price and null to null leave none', () =>
      inRollback(c, async () => {
        const a = await newItem('DTR1', 2);
        const b = await newItem('DTR2', 5);
        const n = await newItem('DTR3', null);
        const core = await buildBackupCore(c, gm);
        const keep = new Set(['DTR1', 'DTR2', 'DTR3']);
        const small = {
          ...core,
          ingredients: core.ingredients
            .filter((i) => keep.has(i.code))
            .map((i) => (i.code === 'DTR1' ? { ...i, price: 2.25 } : i)),
          recipes: [],
          menus: [],
          production: [],
        };
        await applyRestore(c, gm, backupSchema.parse(small), 'prices.json');
        const rows = await c.query(
          `SELECT ingredient_id, old_price, new_price, source FROM ingredient_price_history WHERE ingredient_id = ANY($1::text[])`,
          [[a, b, n]],
        );
        expect(rows.rows).toEqual([{ ingredient_id: a, old_price: 2, new_price: 2.25, source: 'RESTORE' }]);
        expect((await c.query('SELECT price FROM ingredient WHERE id = $1', [a])).rows[0]!.price).toBe(2.25);
      }));
  },
);
