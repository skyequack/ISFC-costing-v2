import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CostItem, CostRecipe } from '@/domain/costing';
import type { ReqContext } from '@/domain/production/requisition';
import type { Catalog } from '@/lib/db/catalog';
import { makeScope } from '@/lib/db/scope';
import { loadTva } from '@/lib/services/dash-stock';
import { connect, hasTestDb, insertIngredient, insertRecipe } from './helpers';

const item: CostItem = { code: 'TV-ING', name: 'Flour', uom: 'Gram', price: 2 };
const card: CostRecipe = {
  code: 'TV-CARD',
  name: 'Bread',
  type: 'menu',
  output: 1,
  subQty: 0,
  subUom: '',
  batchOut: 0,
  batchUom: '',
  price: 10,
  lines: [{ code: 'TV-ING', qty: 100, unit: 'Gram' }],
};
const reqCtx: ReqContext = { items: new Map([[item.code, item]]), recipes: [card], conv: new Map() };
const catalog = { settings: { buffer: 0.1 } } as unknown as Catalog;

describe.skipIf(!hasTestDb)('theoretical vs actual loader (D-74)', { timeout: 120_000 }, () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await connect();
  }, 60_000);
  afterAll(async () => {
    await c.end();
  });
  beforeEach(async () => {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.query('BEGIN');
  });

  /** Brand TV lists site TS; 10 portions on 10-05 and 10 on 10-20 (T = 2000, allowed up to 2200); 100 more on 11-05. */
  async function fixture(extraBrandSites: string[] = []) {
    const brand = (
      await c.query(
        `INSERT INTO brand (legacy_id, code, name, locations) VALUES ('TV','TV','TV',ARRAY['TS']) RETURNING id`,
      )
    ).rows[0]!.id as string;
    if (extraBrandSites.length)
      await c.query(`INSERT INTO brand (legacy_id, code, name, locations) VALUES ('TW','TW','TW',$1)`, [
        extraBrandSites,
      ]);
    await insertIngredient(c, 'TV-ING', 2);
    await insertRecipe(c, brand, 'TV-CARD');
    const prod = (month: string, day: string, loc: string, qty: number, client = '') =>
      c.query(
        `INSERT INTO production_entry (month, day, location, client_id, recipe_code, portions) VALUES ($1,$2,$3,$4,'TV-CARD',$5)`,
        [month, day, loc, client, qty],
      );
    await prod('2026-10', '05', 'TS', 10);
    await prod('2026-10', '20', 'TS', 10);
    await prod('2026-11', '05', 'TS', 100);
    await prod('2026-10', '12', '', 4); // no site
    const count = (date: string, qty: number) =>
      c.query(`INSERT INTO stock_count (site, count_date, code, qty) VALUES ('TS',$1,'TV-ING',$2)`, [date, qty]);
    const receipt = (date: string, qty: number) =>
      c.query(`INSERT INTO receipt (site, receipt_date, code, qty) VALUES ('TS',$1,'TV-ING',$2)`, [date, qty]);
    return { brand, count, receipt };
  }

  const run = (brand: string, o: Partial<Parameters<typeof loadTva>[0]> = {}) =>
    loadTva({
      db: c,
      scope: makeScope([brand]),
      catalog,
      reqCtx,
      brandIds: [brand],
      brand: '*',
      allSites: ['TS'],
      siteList: ['TS'],
      from: '2026-10-01',
      to: '2026-10-31',
      client: null,
      menuCodes: new Set(['TV-CARD']),
      full: false,
      ...o,
    });

  it('compares over the days between the counts: within, over and under', async () => {
    const { brand, count, receipt } = await fixture();
    await count('2026-10-01', 5000);
    await receipt('2026-10-01', 999); // the opening day itself is not in the window
    await receipt('2026-10-10', 500);
    await receipt('2026-10-31', 100); // the closing day is
    await receipt('2026-11-02', 777); // after the window
    await count('2026-10-31', 3600); // U = 5000 + 600 - 3600 = 2000
    let t = await run(brand);
    expect(t.mode).toBe('actual');
    expect(t.sites).toEqual([{ site: 'TS', state: 'counted', from: '2026-10-01', to: '2026-10-31' }]);
    expect(t.rows[0]).toMatchObject({ code: 'TV-ING', theoretical: 2000, actual: 2000, verdict: 'within' });
    expect(t.rows[0]!.ceiling).toBeCloseTo(2200, 9);

    await c.query(`UPDATE stock_count SET qty = 3300 WHERE count_date = '2026-10-31'`); // U = 2300 > 2200
    t = await run(brand);
    expect(t.rows[0]).toMatchObject({ actual: 2300, deviation: 300, value: 600, verdict: 'over' });

    await c.query(`UPDATE stock_count SET qty = 4100 WHERE count_date = '2026-10-31'`); // U = 1500 < 1600
    t = await run(brand);
    expect(t.rows[0]).toMatchObject({ actual: 1500, deviation: -500, verdict: 'under' });
  });

  it('the window follows the counts, not the filter: a count before the range start opens it', async () => {
    const { brand, count } = await fixture();
    await count('2026-09-20', 5000); // latest on or before 10-01
    await count('2026-10-28', 3000); // latest on or before 10-31
    const t = await run(brand);
    expect(t.sites[0]).toMatchObject({ state: 'counted', from: '2026-09-20', to: '2026-10-28' });
    expect(t.rows[0]!.actual).toBe(2000);
  });

  it('theoretical only, never 0: no counts, one count, same-day counts, no date range, a Client filter', async () => {
    const { brand, count } = await fixture();
    const t = await run(brand);
    expect(t).toMatchObject({ mode: 'theoretical', reason: 'no-count', counted: 0 });
    expect(t.rows[0]).toMatchObject({ theoretical: 2000, actual: null, deviation: null, verdict: null });

    await count('2026-10-01', 5000);
    expect((await run(brand)).sites[0]!.state).toBe('no-count'); // opening only: close is the same day
    await count('2026-10-31', 3000);
    expect((await run(brand)).mode).toBe('actual');

    expect(await run(brand, { from: null, to: null })).toMatchObject({ mode: 'theoretical', reason: 'range' });
    expect(await run(brand, { client: '' })).toMatchObject({ mode: 'theoretical', reason: 'client' });
  });

  it('a count for only some ingredients leaves the others n/a', async () => {
    const { brand, count } = await fixture();
    await count('2026-10-01', 5000);
    await c.query(`INSERT INTO stock_count (site, count_date, code, qty) VALUES ('TS','2026-10-31','OTHER',1)`);
    const t = await run(brand);
    expect(t.mode).toBe('actual'); // the site has both count days...
    expect(t.rows.find((r) => r.code === 'TV-ING')).toMatchObject({ actual: null, verdict: null }); // ...but not this item
  });

  it('a site another brand also lists is theoretical only unless the selection covers that brand', async () => {
    const { brand, count } = await fixture(['TS']);
    await count('2026-10-01', 5000);
    await count('2026-10-31', 3000);
    expect(await run(brand)).toMatchObject({ mode: 'theoretical', reason: 'shared' });
    const other = (await c.query(`SELECT id FROM brand WHERE code = 'TW'`)).rows[0]!.id as string;
    expect((await run(brand, { brandIds: [brand, other] })).mode).toBe('actual');
  });

  it('production with no site is reported on its own, in the all-sites view only', async () => {
    const { brand } = await fixture();
    const all = await run(brand);
    expect(all.unallocated).toMatchObject({ portions: 4, unpriced: 0 });
    expect(all.unallocated!.value).toBeCloseTo(4 * 100 * 2, 9);
    expect(all.rows[0]!.theoretical).toBe(2000); // never added to a site
    expect(await run(brand, { allSites: ['TS', 'TS2'], siteList: ['TS'] })).toMatchObject({ unallocated: null });
  });
});
