import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cost } from '@/domain/costing';
import type { SessionUser } from '@/lib/auth/types';
import { loadCatalog } from '@/lib/db/catalog';
import { buildCtx } from '@/lib/screens/ctx';
import { loadProd } from '@/lib/screens/prod';
import { loadAsOf } from '@/lib/services/asof';
import { dashFilters, loadDashAnalytics } from '@/lib/services/dash';
import { buildExport, exportQuery } from '@/lib/services/exports';
import { connect, hasTestDb, inRollback, insertBrand, insertIngredient } from './helpers';

const gm: SessionUser = { id: 'u-gm', clerkUserId: 'c-gm', email: null, name: 'T gm', role: 'gm' };

describe.skipIf(!hasTestDb)(
  'costing by date (D-100, B3) against the database (all rolled back)',
  { timeout: 120_000 },
  () => {
    let c: pg.Client;
    beforeAll(async () => {
      c = await connect();
    }, 60_000);
    afterAll(async () => {
      await c.end();
    });

    const mkGm = async (): Promise<SessionUser> => {
      const { rows } = await c.query(`INSERT INTO app_user (clerk_user_id, name) VALUES ($1,$2) RETURNING id`, [
        `clerk-gm-${Math.random()}`,
        'T gm',
      ]);
      return { ...gm, id: rows[0]!.id as string };
    };
    const prod = (month: string, day: string, code: string, q: number) =>
      c.query(`INSERT INTO production_entry (month, day, location, recipe_code, portions) VALUES ($1,$2,'',$3,$4)`, [
        month,
        day,
        code,
        q,
      ]);
    const lines = async (recipeId: string, qty: number) =>
      c.query(
        `INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit, y, yp) VALUES ($1, 0, 'CBD1', $2, 'Gram', 1, NULL)`,
        [recipeId, qty],
      );

    /**
     * A menu card 'ZB-MN-1' that used 50 g of CBD1 until 2026-05-31 (archived, approved) and uses 100 g since 2026-06-01 (live,
     * approved). The item costs 0.01 per gram; the card sells at 5.
     */
    async function world(opts: { liveStatus?: 'DRAFT' | 'LOCKED' } = {}) {
      const brand = await insertBrand(c, 'ZB');
      await insertIngredient(c, 'CBD1', 0.01);
      const id = (
        await c.query(
          `INSERT INTO recipe (code, name, category, type, brand_id, selling_price, status, revision, effective_from)
         VALUES ('ZB-MN-1', 'Dated dish', 'c', 'MENU', $1, 5, $2, 2, '2026-06-01') RETURNING id`,
          [brand, opts.liveStatus ?? 'LOCKED'],
        )
      ).rows[0]!.id as string;
      await lines(id, 100);
      const v = (
        await c.query(
          `INSERT INTO recipe_version (recipe_id, revision, effective_from, effective_to, name, category, type, brand_id, output, sub_qty, sub_uom, batch_out, batch_uom, selling_price, status, origin, created_by)
         VALUES ($1, 1, '2026-01-01', '2026-06-01', 'Dated dish', 'c', 'MENU', $2, 1, 0, 'Gram', 0, 'Gram', 5, 'LOCKED', 'BUTTON', 'seed') RETURNING id`,
          [id, brand],
        )
      ).rows[0]!.id as string;
      await c.query(
        `INSERT INTO recipe_version_line (version_id, sort_order, code, qty, unit, y, yp) VALUES ($1, 0, 'CBD1', 50, 'Gram', 1, NULL)`,
        [v],
      );
      await prod('2026-05', '10', 'ZB-MN-1', 10);
      await prod('2026-06', '10', 'ZB-MN-1', 20);
      return { brand, id };
    }
    /** what the unchanged engine says the card costs with `qty` grams, today's prices */
    const foodWith = async (qty: number) => {
      const cat = await loadCatalog(c);
      const r = cat.context.recipes.get('ZB-MN-1')!;
      return cost({ ...r, lines: [{ ...r.lines[0]!, qty }] }, cat.context).food;
    };
    const dishFood = async (month: string, day: string, view: 'day' | 'month' = 'day') => {
      const user = await mkGm();
      const d = await loadProd(c, await buildCtx(c, user), await loadCatalog(c), {
        view,
        month,
        day,
        brand: '*',
        loc: '*',
        client: '*',
      });
      return { d, food: d.sections.flatMap((s) => s.cards).find((x) => x.code === 'ZB-MN-1')?.food };
    };

    it('with no history anywhere in the range nothing is loaded and the current catalog is returned as it is', () =>
      inRollback(c, async () => {
        const cat = await loadCatalog(c);
        const a = await loadAsOf(c, cat, '2026-01-01');
        expect(a.active).toBe(false);
        expect(a.catalogFor('2026-05-05')).toBe(cat);
      }));

    it('the Production screen costs a day with the approved revision in force that day', () =>
      inRollback(c, async () => {
        await world();
        const old = await foodWith(50);
        const now = await foodWith(100);
        expect(old).toBeLessThan(now);
        expect((await dishFood('2026-05', '10')).food).toBe(old); // before the new revision started
        expect((await dishFood('2026-06', '10')).food).toBe(now);
        // the day the revision starts is already the new one (half-open)
        await prod('2026-06', '01', 'ZB-MN-1', 1);
        expect((await dishFood('2026-06', '01')).food).toBe(now);
        await prod('2026-05', '31', 'ZB-MN-1', 1);
        expect((await dishFood('2026-05', '31')).food).toBe(old);
        // monthly view: each day with its own cost
        const m = (await dishFood('2026-05', '10', 'month')).d;
        expect(m.monthTotals.total).toBeCloseTo(old * 11, 9);
        const j = (await dishFood('2026-06', '10', 'month')).d;
        expect(j.monthTotals.total).toBeCloseTo(now * 21, 9);
      }));

    it('a draft live revision is ignored while an older approved one exists; a card never approved is costed as it is and flagged', () =>
      inRollback(c, async () => {
        await world({ liveStatus: 'DRAFT' });
        const old = await foodWith(50);
        // the live card is a draft: production on 2026-06-10 still uses the approved revision, not the unapproved edit
        const d = await dishFood('2026-06', '10');
        expect(d.food).toBe(old);
        expect(d.d.unapproved).toEqual([]); // it HAS an approved revision
        // a card with no approved revision at all
        const brand = (await c.query(`SELECT brand_id FROM recipe WHERE code = 'ZB-MN-1'`)).rows[0]!.brand_id as string;
        await c.query(
          `INSERT INTO recipe (code, name, category, type, brand_id, selling_price) VALUES ('ZB-MN-2', 'Never approved', 'c', 'MENU', $1, 5)`,
          [brand],
        );
        await prod('2026-06', '10', 'ZB-MN-2', 4);
        const d2 = await dishFood('2026-06', '10');
        expect(d2.d.unapproved).toEqual([{ code: 'ZB-MN-2', name: 'Never approved' }]);
        expect(d2.d.sections.flatMap((s) => s.cards).some((x) => x.code === 'ZB-MN-2')).toBe(true); // flagged, not dropped
      }));

    it('ingredient prices by day: a change on 2026-06-01 does not touch earlier days', () =>
      inRollback(c, async () => {
        const brand = await insertBrand(c, 'ZC');
        const item = await insertIngredient(c, 'CBD2', 0.03); // the current price
        await c.query(
          `INSERT INTO ingredient_price_history (ingredient_id, old_price, new_price, source, user_name_snapshot, effective_on) VALUES ($1, 0.01, 0.03, 'MANUAL', 'x', '2026-06-01')`,
          [item],
        );
        const id = (
          await c.query(
            `INSERT INTO recipe (code, name, category, type, brand_id, selling_price) VALUES ('ZC-MN-1', 'Priced dish', 'c', 'MENU', $1, 5) RETURNING id`,
            [brand],
          )
        ).rows[0]!.id as string;
        await c.query(
          `INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit, y, yp) VALUES ($1, 0, 'CBD2', 100, 'Gram', 1, NULL)`,
          [id],
        );
        await prod('2026-05', '31', 'ZC-MN-1', 1);
        await prod('2026-06', '01', 'ZC-MN-1', 1);
        const cat = await loadCatalog(c);
        const r = cat.context.recipes.get('ZC-MN-1')!;
        const at = (price: number) =>
          cost(r, {
            ...cat.context,
            items: new Map([...cat.context.items, ['CBD2', { ...cat.context.items.get('CBD2')!, price }]]),
          }).food;
        const user = await mkGm();
        const ctx = await buildCtx(c, user);
        const food = async (month: string, day: string) =>
          (await loadProd(c, ctx, cat, { view: 'day', month, day, brand: '*', loc: '*', client: '*' })).sections
            .flatMap((s) => s.cards)
            .find((x) => x.code === 'ZC-MN-1')!.food;
        expect(await food('2026-05', '31')).toBe(at(0.01));
        expect(await food('2026-06', '01')).toBe(at(0.03));
      }));

    it('the production export costs every day with its own revision and the requisition export follows the day', () =>
      inRollback(c, async () => {
        await world();
        const old = await foodWith(50);
        const now = await foodWith(100);
        const user = await mkGm();
        const exp = async (month: string) =>
          (await buildExport(c, user, 'production', exportQuery.parse({ month, brand: '*', loc: '*', client: '*' })))
            .rows;
        const may = (await exp('2026-05')).find((r) => r[6] === 'ZB-MN-1')!;
        const jun = (await exp('2026-06')).find((r) => r[6] === 'ZB-MN-1')!;
        expect(Number(may[8])).toBeCloseTo(old, 4);
        expect(Number(jun[8])).toBeCloseTo(now, 4);
        const req = async (month: string, day: string) =>
          (
            await buildExport(
              c,
              user,
              'requisition',
              exportQuery.parse({ month, day, brand: '*', loc: '*', client: '*' }),
            )
          ).rows;
        const qty = (rows: unknown[][]) => Number((rows.find((r) => r[0] === 'CBD1') as unknown[])[3]);
        expect(qty(await req('2026-05', '10'))).toBeGreaterThan(0);
        // 20 portions of 100 g in June against 10 portions of 50 g in May (issue quantities follow the revision of the day)
        expect(qty(await req('2026-06', '10')) / qty(await req('2026-05', '10'))).toBeGreaterThan(3.9);
      }));

    it('the dashboard costs each period with its revision: the whole range equals the two periods added together', () =>
      inRollback(c, async () => {
        await world();
        const user = await mkGm();
        const ctx = await buildCtx(c, user);
        const run = async (from: string, to: string) =>
          loadDashAnalytics(c, ctx, await loadCatalog(c), dashFilters.parse({ from, to }));
        const may = await run('2026-05-01', '2026-05-31');
        const jun = await run('2026-06-01', '2026-06-30');
        const all = await run('2026-05-01', '2026-06-30');
        expect(all.portions).toBe(30);
        expect(may.portions).toBe(10);
        expect(jun.portions).toBe(20);
        expect(all.drivers.total).toBeCloseTo(may.drivers.total + jun.drivers.total, 9);
        // May used 50 g, June 100 g: the cost per portion of the two single periods differs, and the whole range sits between
        const perPortion = (d: typeof may) => d.drivers.total / d.portions;
        expect(perPortion(may)).toBeLessThan(perPortion(jun));
        expect(perPortion(all)).toBeGreaterThan(perPortion(may));
        expect(perPortion(all)).toBeLessThan(perPortion(jun));
        // margin at risk: the card sells at 5, so food above 1.5 per portion is at risk; the range weights both periods
        const food = (d: typeof may) => d.risk.rows.find((r) => r.code === 'ZB-MN-1');
        const total = (d: typeof may) => d.risk.total;
        expect(total(all)).toBeCloseTo(total(may) + total(jun), 9);
        void food;
      }));

    it('a range that crosses more than 60 costing periods is refused with a message', () =>
      inRollback(c, async () => {
        await world();
        const user = await mkGm();
        const ctx = await buildCtx(c, user);
        // 61 price changes of the item on 61 different days, with production on each day
        const item = (await c.query(`SELECT id FROM ingredient WHERE code = 'CBD1'`)).rows[0]!.id as string;
        for (let i = 0; i < 62; i++) {
          const d = new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10);
          await c.query(
            `INSERT INTO ingredient_price_history (ingredient_id, old_price, new_price, source, user_name_snapshot, effective_on) VALUES ($1, 0.01, 0.01, 'MANUAL', 'x', $2)`,
            [item, d],
          );
          await prod(d.slice(0, 7), d.slice(8, 10), 'ZB-MN-1', 1);
        }
        await expect(
          loadDashAnalytics(c, ctx, await loadCatalog(c), dashFilters.parse({ from: '2026-07-01', to: '2026-09-30' })),
        ).rejects.toMatchObject({ status: 422 });
      }));
  },
);
