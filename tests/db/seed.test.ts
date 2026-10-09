import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cost } from '@/domain/costing';
import { loadCatalog } from '@/lib/db/catalog';
import { getBrand, listBrands } from '@/lib/db/repo/brands';
import { listIngredients } from '@/lib/db/repo/ingredients';
import { getRecipe, listRecipes } from '@/lib/db/repo/recipes';
import { getSettings } from '@/lib/db/repo/settings';
import { makeScope } from '@/lib/db/scope';
import { pgImageStore } from '@/lib/images';
import { validateImage } from '@/lib/images/sniff';
import { EXPECTED_COUNTS, currentCounts, readSeedInputs, seedDatabase } from '@/lib/seed/seed';
import { goldenCosts, goldenState } from '../helpers/golden';
import { connect, expectFails, hasTestDb, inRollback } from './helpers';

const root = path.resolve(__dirname, '../..');
const seedJson = <T>(name: string): T => JSON.parse(readFileSync(path.join(root, 'db/seed-data', name), 'utf8'));

describe.skipIf(!hasTestDb)('seed + post-seed verification (docs/TESTING.md §2, schema.md)', () => {
  let c: pg.Client;
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await c.query(sql, params)).rows as T[];
  const n = async (sql: string, params: unknown[] = []) => Number((await q<{ n: string }>(sql, params))[0]!.n);

  beforeAll(async () => {
    c = await connect();
    // Dev is already seeded (no-op); a fresh CI branch gets seeded here. A second call must change nothing.
    const first = await seedDatabase(c, readSeedInputs(root));
    expect(['seeded', 'already-seeded']).toContain(first.status);
  }, 120_000);
  afterAll(async () => {
    await c.end();
  });

  it('seeding twice is a no-op with identical counts', async () => {
    const before = await currentCounts(c);
    const again = await seedDatabase(c, readSeedInputs(root));
    expect(again.status).toBe('already-seeded');
    expect(await currentCounts(c)).toEqual(before);
    expect(await n('SELECT count(*) AS n FROM seed_run')).toBe(1);
  });

  it('row counts match the legacy data', async () => {
    const counts = await currentCounts(c);
    expect(counts).toEqual(EXPECTED_COUNTS);
    expect(await n('SELECT count(*) AS n FROM ingredient WHERE price IS NULL')).toBe(135);
    expect(await n(`SELECT count(*) AS n FROM ingredient WHERE flag <> ''`)).toBe(161);
    const scopeSum = seedJson<{ brands?: string[] }[]>('items.json').reduce((a, i) => a + (i.brands?.length ?? 0), 0);
    expect(await n('SELECT count(*) AS n FROM item_brand_scope')).toBe(scopeSum);
    expect(await n(`SELECT count(*) AS n FROM menu_cell WHERE kind = 'ITEM'`)).toBe(710);
    expect(await n(`SELECT count(*) AS n FROM menu_cell WHERE kind = 'RECIPE'`)).toBe(290);
    expect(await n(`SELECT count(*) AS n FROM menu_cell WHERE kind = 'NONE'`)).toBe(1);
    expect(await n('SELECT count(*) AS n FROM cost_settings')).toBe(1);
  });

  it('code sets equal the JSON both ways; no whitespace; no case collisions anywhere', async () => {
    const itemCodes = seedJson<{ code: string }[]>('items.json').map((i) => i.code);
    const recipeCodes = seedJson<{ code: string }[]>('recipes.json').map((r) => r.code);
    const dbItems = (await q<{ code: string }>('SELECT code FROM ingredient')).map((r) => r.code);
    const dbRecipes = (await q<{ code: string }>('SELECT code FROM recipe')).map((r) => r.code);
    expect(new Set(dbItems)).toEqual(new Set(itemCodes));
    expect(new Set(dbRecipes)).toEqual(new Set(recipeCodes));
    expect(await n(`SELECT count(*) AS n FROM ingredient WHERE code <> btrim(code)`)).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM recipe WHERE code <> btrim(code)`)).toBe(0);
    expect(
      await n('SELECT count(*) AS n FROM (SELECT lower(code) FROM ingredient GROUP BY 1 HAVING count(*) > 1) x'),
    ).toBe(0);
    expect(await n('SELECT count(*) AS n FROM (SELECT lower(code) FROM recipe GROUP BY 1 HAVING count(*) > 1) x')).toBe(
      0,
    );
    expect(await n('SELECT count(*) AS n FROM ingredient i JOIN recipe r ON lower(i.code) = lower(r.code)')).toBe(0);
  });

  it('every line code resolves; no MENU recipe used as a line; no self references', async () => {
    expect(
      await n(`SELECT count(*) AS n FROM recipe_line l
               WHERE l.code <> '' AND NOT EXISTS (SELECT 1 FROM ingredient i WHERE i.code = l.code)
                 AND NOT EXISTS (SELECT 1 FROM recipe r WHERE lower(r.code) = lower(l.code))`),
    ).toBe(0);
    expect(
      await n(
        `SELECT count(*) AS n FROM recipe_line l JOIN recipe r ON lower(r.code) = lower(l.code) WHERE r.type = 'MENU'`,
      ),
    ).toBe(0);
    expect(
      await n(
        `SELECT count(*) AS n FROM recipe_line l JOIN recipe r ON r.id = l.recipe_id WHERE lower(l.code) = lower(r.code)`,
      ),
    ).toBe(0);
  });

  it('menu cells and PLAN_ALIAS targets resolve', async () => {
    expect(
      await n(
        `SELECT count(*) AS n FROM menu_cell m WHERE m.kind = 'ITEM' AND NOT EXISTS (SELECT 1 FROM ingredient i WHERE i.code = m.code)`,
      ),
    ).toBe(0);
    expect(
      await n(
        `SELECT count(*) AS n FROM menu_cell m WHERE m.kind = 'RECIPE' AND NOT EXISTS (SELECT 1 FROM recipe r WHERE r.code = m.code)`,
      ),
    ).toBe(0);
    const alias = seedJson<Record<string, string>>('plan-alias.json');
    for (const target of Object.values(alias))
      expect(await n('SELECT count(*) AS n FROM recipe WHERE code = $1', [target]), target).toBe(1);
    expect(await n(`SELECT count(*) AS n FROM menu WHERE legacy_index IS NULL`)).toBe(0);
  });

  it('doubles round-trip bit-identically (BKR2-2058, DRS1-4772, every seeded price)', async () => {
    const [a] = await q<{ price: number }>(`SELECT price FROM ingredient WHERE code = 'BKR2-2058'`);
    const [b] = await q<{ price: number }>(`SELECT price FROM ingredient WHERE code = 'DRS1-4772'`);
    expect(Object.is(a!.price, 0.006667)).toBe(true);
    expect(Object.is(b!.price, 0.0064)).toBe(true);
    const db = new Map(
      (await q<{ code: string; price: number | null }>('SELECT code, price FROM ingredient')).map((r) => [
        r.code,
        r.price,
      ]),
    );
    for (const i of seedJson<{ code: string; price: number | null }[]>('items.json'))
      expect(Object.is(db.get(i.code), i.price), i.code).toBe(true);
  });

  it('lines keep yp NULL (not 0) and recipe fields verbatim', async () => {
    const recipes =
      seedJson<{ code: string; lines: { yp?: number | null }[]; buffer: number; price: number }[]>('recipes.json');
    const nullYp = recipes.reduce((a, r) => a + r.lines.filter((l) => l.yp === undefined || l.yp === null).length, 0);
    expect(await n('SELECT count(*) AS n FROM recipe_line WHERE yp IS NULL')).toBe(nullYp);
    expect(await n('SELECT count(*) AS n FROM recipe_line WHERE yp = 0')).toBe(0);
    const db = new Map(
      (
        await q<{ code: string; buffer: number | null; selling_price: number }>(
          'SELECT code, buffer, selling_price FROM recipe',
        )
      ).map((r) => [r.code, r]),
    );
    for (const r of recipes) {
      expect(Object.is(db.get(r.code)!.buffer, r.buffer), r.code).toBe(true);
      expect(Object.is(db.get(r.code)!.selling_price, r.price), r.code).toBe(true);
    }
  });

  it('all 321 costs recomputed from the DB equal golden/costs.json exactly', async () => {
    const cat = await loadCatalog(c);
    const goldenId = new Map(goldenState.recipes.map((r) => [r.code, r.id]));
    let checked = 0;
    for (const card of cat.context.recipes.values()) {
      const expected = goldenCosts[`${card.code}|${goldenId.get(card.code)}`];
      expect(expected, card.code).toBeDefined();
      const actual = cost(card, cat.context) as unknown as Record<string, unknown>;
      for (const k of Object.keys(expected!))
        expect(Object.is(actual[k], expected![k]), `${card.code} ${k}`).toBe(true);
      checked++;
    }
    expect(checked).toBe(321);
  });

  it('seeded logos are byte-identical to public/assets', async () => {
    const brands = seedJson<{ id: string; logoFile: string | null }[]>('brands.json');
    for (const b of brands) {
      const rows = await q<{ sha256: string; data: Buffer }>(
        'SELECT l.sha256, l.data FROM brand_logo l JOIN brand b ON b.id = l.brand_id WHERE b.legacy_id = $1',
        [b.id],
      );
      if (!b.logoFile) {
        expect(rows, b.id).toHaveLength(0);
        continue;
      }
      const file = readFileSync(path.join(root, 'public/assets', b.logoFile));
      expect(rows[0]!.sha256, b.id).toBe(createHash('sha256').update(file).digest('hex'));
      expect(Buffer.compare(rows[0]!.data, file)).toBe(0);
    }
  });

  it('partial unique index: case variant rejected, soft-delete then reuse allowed', async () => {
    await inRollback(c, async () => {
      const [r] = await q<{ id: string; brand_id: string }>(
        `SELECT id, brand_id FROM recipe WHERE code = 'GRM-MN-0001'`,
      );
      await expectFails(
        c,
        `INSERT INTO recipe (code, name, category, type, brand_id) VALUES ('grm-mn-0001','x','c','MENU',$1)`,
        [r!.brand_id],
        '23505',
      );
      await c.query(`UPDATE recipe SET deleted_at = now() WHERE id = $1`, [r!.id]);
      await c.query(
        `INSERT INTO recipe (code, name, category, type, brand_id) VALUES ('GRM-MN-0001','again','c','MENU',$1)`,
        [r!.brand_id],
      );
    });
  });

  describe('repositories (brand scope)', () => {
    const idOf = async (legacy: string) =>
      (await q<{ id: string }>('SELECT id FROM brand WHERE legacy_id = $1', [legacy]))[0]!.id;

    it('recipes: a scoped user sees only their brand, never bytes; out-of-scope id is 404', async () => {
      const grm = await idOf('b1');
      const nc = await idOf('bnc');
      const scope = makeScope([grm]);
      const list = await listRecipes(c, scope);
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list.map((r) => r.brandId))).toEqual(new Set([grm]));
      expect(JSON.stringify(list[0])).not.toMatch(/"data"/);
      const other = (await q<{ id: string }>('SELECT id FROM recipe WHERE brand_id = $1 LIMIT 1', [nc]))[0]!;
      await expect(getRecipe(c, scope, other.id)).rejects.toMatchObject({ status: 404 });
      await expect(getRecipe(c, scope, 'no-such-id')).rejects.toMatchObject({ status: 404 });
      const all = await listRecipes(c, makeScope([]));
      expect(all).toHaveLength(0);
    });

    it('recipe detail returns ordered lines, null yp preserved, method steps', async () => {
      const gm = makeScope((await q<{ id: string }>('SELECT id FROM brand')).map((b) => b.id));
      const row = (await q<{ id: string }>(`SELECT id FROM recipe WHERE code = 'GRM-SR-0001'`))[0]!;
      const r = await getRecipe(c, gm, row.id);
      expect(r.lines.map((l) => l.code)).toEqual(['DRY2-5369', 'PRD1-4327', 'PRD1-227', 'DRS1-114', 'DRS6-537']);
      expect(r.lines.every((l) => l.yp === null || l.yp === 15)).toBe(true);
      expect(r.method).toHaveLength(5);
      expect(r.status).toBe('DRAFT');
    });

    it('ingredients: Shared visible to all, scoped ones only to their brands; null price stays null', async () => {
      const nc = await idOf('bnc');
      const none = await listIngredients(c, makeScope([]));
      const ncOnly = await listIngredients(c, makeScope([nc]));
      expect(none.every((i) => i.brandIds.length === 0)).toBe(true);
      expect(ncOnly.length).toBeGreaterThan(none.length);
      expect(none.some((i) => i.price === null)).toBe(true);
      expect(none.every((i) => i.price === null || i.price >= 0)).toBe(true);
      const conv = none.find((i) => i.code === 'BKR1-3695');
      expect(conv?.conv).toEqual({ recipeUnit: 'Gram', factor: 60 });
    });

    it('brands + settings', async () => {
      const ids = (await q<{ id: string }>('SELECT id FROM brand')).map((b) => b.id);
      const brands = await listBrands(c, makeScope(ids));
      expect(brands).toHaveLength(14);
      expect(brands.filter((b) => b.logoSha).length).toBe(9);
      const ssem = brands.find((b) => b.code === 'SSEM')!;
      expect(ssem.locations).toEqual(['NIC', 'NEOM', 'JUBAIL', 'YANBU']);
      await expect(getBrand(c, makeScope([]), ssem.id)).rejects.toMatchObject({ status: 404 });
      const s = await getSettings(c);
      expect(s).toMatchObject({ currency: 'SAR', pkg: 0.1, vat: 0.15, version: 0 });
      expect(s.priceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('ImageStore (Postgres)', () => {
    // 1x1 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );

    it('put / get / meta / replace / delete round trip with equal bytes and sha256', async () => {
      await inRollback(c, async () => {
        const [r] = await q<{ id: string }>(`SELECT id FROM recipe WHERE code = 'GRM-MN-0001'`);
        const store = pgImageStore(c, 'photo');
        const v = validateImage(png, 'photo');
        expect(await store.get(r!.id)).toBeNull();
        await store.put(r!.id, v, png);
        const got = await store.get(r!.id);
        expect(Buffer.compare(got!.data, png)).toBe(0);
        expect(got).toMatchObject({
          contentType: 'image/png',
          sha256: v.sha256,
          width: 1,
          height: 1,
          size: png.length,
        });
        expect(await store.meta(r!.id)).toEqual({
          contentType: 'image/png',
          sha256: v.sha256,
          width: 1,
          height: 1,
          size: png.length,
        });
        await store.put(r!.id, v, png); // replace
        expect(await n('SELECT count(*) AS n FROM recipe_photo WHERE recipe_id = $1', [r!.id])).toBe(1);
        const list = await listRecipes(
          c,
          makeScope([
            (await q<{ brand_id: string }>('SELECT brand_id FROM recipe WHERE id = $1', [r!.id]))[0]!.brand_id,
          ]),
        );
        expect(list.find((x) => x.id === r!.id)!.photoSha).toBe(v.sha256);
        expect(await store.delete(r!.id)).toBe(true);
        expect(await store.delete(r!.id)).toBe(false);
      });
    });
  });
});
