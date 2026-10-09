import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { connect, expectFails, hasTestDb, inRollback, insertBrand, insertIngredient, insertRecipe } from './helpers';

const EXPECTED_TABLES = [
  'app_user',
  'audit_log',
  'brand',
  'brand_logo',
  'cost_settings',
  'ingredient',
  'ingredient_price_history',
  'item_brand_scope',
  'menu',
  'menu_cell',
  'menu_pax',
  'menu_row',
  'production_entry',
  'recipe',
  'recipe_history_entry',
  'recipe_line',
  'recipe_method_step',
  'recipe_photo',
  'seed_run',
  'unit_conversion',
  'user_brand_access',
];

describe.skipIf(!hasTestDb)('schema (db/migrations) on a real Neon branch', () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await connect();
  });
  afterAll(async () => {
    await c.end();
  });

  it('has exactly the documented tables and the migrations are recorded', async () => {
    const { rows } = await c.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> 'schema_migrations' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES);
    const m = await c.query(`SELECT name FROM schema_migrations WHERE name = '0001_init.sql'`);
    expect(m.rowCount).toBe(1);
  });

  it('audit_log is append-only (update, delete and truncate are refused)', () =>
    inRollback(c, async () => {
      await c.query(`INSERT INTO audit_log (user_name_snapshot, role_snapshot, action) VALUES ('t','gm','x')`);
      await expectFails(c, `UPDATE audit_log SET detail = 'y'`, [], 'append-only');
      await expectFails(c, `DELETE FROM audit_log`, [], 'append-only');
      await expectFails(c, `TRUNCATE audit_log`, [], 'append-only');
    }));

  it('recipe code is unique case-insensitively among live recipes; soft-deleted codes are reusable', () =>
    inRollback(c, async () => {
      const brand = await insertBrand(c);
      await insertRecipe(c, brand, 'Abc-MN-0001');
      await expectFails(
        c,
        `INSERT INTO recipe (code,name,category,type,brand_id) VALUES ('aBC-mn-0001','n','c','MENU',$1)`,
        [brand],
        '23505',
      );
      await c.query(`UPDATE recipe SET deleted_at = now() WHERE code = 'Abc-MN-0001'`);
      await insertRecipe(c, brand, 'ABC-MN-0001'); // reuse after soft delete
    }));

  it('ingredient: null price allowed, negative/NaN/infinite refused, uom allowlist', () =>
    inRollback(c, async () => {
      await insertIngredient(c, 'I-NULL', null);
      await expectFails(
        c,
        `INSERT INTO ingredient (code,name,uom,price,category,subcategory) VALUES ('I-NEG','n','Gram',-1,'c','s')`,
        [],
        '23514',
      );
      await expectFails(
        c,
        `INSERT INTO ingredient (code,name,uom,price,category,subcategory) VALUES ('I-NAN','n','Gram','NaN','c','s')`,
        [],
        '23514',
      );
      await expectFails(
        c,
        `INSERT INTO ingredient (code,name,uom,price,category,subcategory) VALUES ('I-INF','n','Gram','Infinity','c','s')`,
        [],
        '23514',
      );
      await expectFails(
        c,
        `INSERT INTO ingredient (code,name,uom,price,category,subcategory) VALUES ('I-UOM','n','Kg',1,'c','s')`,
        [],
        '23514',
      );
      await expectFails(
        c,
        `INSERT INTO ingredient (code,name,uom,price,category,subcategory) VALUES ('I-NULL','n','Gram',1,'c','s')`,
        [],
        '23505',
      ); // code is case-sensitive unique
    }));

  it('doubles round-trip exactly (price 0.006667, 10 decimals)', () =>
    inRollback(c, async () => {
      for (const p of [0.006667, 0.0064, 0.00008, 0.1234567891]) {
        const id = await insertIngredient(c, `I-${p}`, p);
        const { rows } = await c.query<{ price: number }>('SELECT price FROM ingredient WHERE id = $1', [id]);
        expect(Object.is(rows[0]!.price, p)).toBe(true);
      }
    }));

  it('recipe_line / unit_conversion / production / pax checks', () =>
    inRollback(c, async () => {
      const brand = await insertBrand(c);
      const recipe = await insertRecipe(c, brand, 'R-1');
      const ing = await insertIngredient(c, 'I-1');
      await c.query(`INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit) VALUES ($1, 0, '', 0, 'Gram')`, [
        recipe,
      ]); // blank row is legal
      await expectFails(
        c,
        `INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit, y) VALUES ($1, 1, 'X', 1, 'Gram', 0)`,
        [recipe],
        '23514',
      );
      await expectFails(
        c,
        `INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit) VALUES ($1, 2, 'X', -1, 'Gram')`,
        [recipe],
        '23514',
      );
      await expectFails(
        c,
        `INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit) VALUES ($1, 0, 'X', 1, 'Gram')`,
        [recipe],
        '23505',
      );
      await c.query(
        `INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit, yp) VALUES ($1, 3, 'X', 1, 'Gram', NULL)`,
        [recipe],
      );
      await expectFails(
        c,
        `INSERT INTO unit_conversion (ingredient_id, recipe_unit, factor) VALUES ($1, 'Gram', 0)`,
        [ing],
        '23514',
      );
      await expectFails(
        c,
        `INSERT INTO production_entry (month,day,recipe_code,portions) VALUES ('2026-10','09','R-1',-1)`,
        [],
        '23514',
      );
      await c.query(`INSERT INTO production_entry (month,day,recipe_code,portions) VALUES ('2026-10','09','R-1',5)`);
      await expectFails(
        c,
        `INSERT INTO production_entry (month,day,recipe_code,portions) VALUES ('2026-10','09','R-1',6)`,
        [],
        '23505',
      ); // location '' bucket is part of the key
    }));

  it('menu cells: NONE has no code, others need one; labels are not unique', () =>
    inRollback(c, async () => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO menu (name, sort_order) VALUES ('M', 0) RETURNING id`,
      );
      const menu = rows[0]!.id;
      const r1 = (
        await c.query<{ id: string }>(
          `INSERT INTO menu_row (menu_id, sort_order, meal) VALUES ($1, 0, 'BREAKFAST') RETURNING id`,
          [menu],
        )
      ).rows[0]!.id;
      await c.query(`INSERT INTO menu_row (menu_id, sort_order, meal) VALUES ($1, 1, 'BREAKFAST')`, [menu]);
      await c.query(
        `INSERT INTO menu_cell (row_id, day, kind, code, label) VALUES ($1, 'SATURDAY', 'ITEM', 'MNU-0001', 'x')`,
        [r1],
      );
      await c.query(`INSERT INTO menu_cell (row_id, day, kind, code, label) VALUES ($1, 'SUNDAY', 'NONE', NULL, 'x')`, [
        r1,
      ]);
      await expectFails(
        c,
        `INSERT INTO menu_cell (row_id, day, kind, code, label) VALUES ($1, 'MONDAY', 'NONE', 'MNU-1', 'x')`,
        [r1],
        '23514',
      );
      await expectFails(
        c,
        `INSERT INTO menu_cell (row_id, day, kind, code, label) VALUES ($1, 'TUESDAY', 'RECIPE', NULL, 'x')`,
        [r1],
        '23514',
      );
      await expectFails(
        c,
        `INSERT INTO menu_pax (month,day,menu_id,people) VALUES ('2026-10','09',$1,-1)`,
        [menu],
        '23514',
      );
    }));

  it('images: size and dimension caps; bytea round-trips', () =>
    inRollback(c, async () => {
      const brand = await insertBrand(c);
      const recipe = await insertRecipe(c, brand, 'R-2');
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 1]);
      await c.query(
        `INSERT INTO recipe_photo (recipe_id, content_type, data, size, width, height, sha256) VALUES ($1,'image/png',$2,7,10,10,'h')`,
        [recipe, bytes],
      );
      const { rows } = await c.query<{ data: Buffer }>('SELECT data FROM recipe_photo WHERE recipe_id = $1', [recipe]);
      expect(rows[0]!.data.equals(bytes)).toBe(true);
      await expectFails(c, `UPDATE recipe_photo SET size = 1500001 WHERE recipe_id = $1`, [recipe], '23514');
      await expectFails(c, `UPDATE recipe_photo SET width = 4097 WHERE recipe_id = $1`, [recipe], '23514');
      await expectFails(
        c,
        `INSERT INTO brand_logo (brand_id, content_type, data, size, width, height, sha256) VALUES ($1,'image/png',$2,512001,10,10,'h')`,
        [brand, bytes],
        '23514',
      );
    }));

  it('cost_settings is a singleton; recipe requires a brand; brand with recipes cannot be deleted; deleting a recipe cascades', () =>
    inRollback(c, async () => {
      await c.query(`INSERT INTO cost_settings (price_date) VALUES ('2026-10-09')`);
      await expectFails(c, `INSERT INTO cost_settings (id, price_date) VALUES (2, '2026-10-09')`, [], '23514');
      await expectFails(
        c,
        `INSERT INTO recipe (code,name,category,type,brand_id) VALUES ('R-X','n','c','MENU',NULL)`,
        [],
        '23502',
      );
      const brand = await insertBrand(c);
      const recipe = await insertRecipe(c, brand, 'R-3');
      await c.query(`INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit) VALUES ($1, 0, 'X', 1, 'Gram')`, [
        recipe,
      ]);
      await expectFails(c, `DELETE FROM brand WHERE id = $1`, [brand], '23001');
      await c.query('DELETE FROM recipe WHERE id = $1', [recipe]);
      const left = await c.query('SELECT 1 FROM recipe_line WHERE recipe_id = $1', [recipe]);
      expect(left.rowCount).toBe(0);
    }));

  it('updated_at trigger bumps the timestamp on update', () =>
    inRollback(c, async () => {
      const brand = await insertBrand(c);
      const recipe = await insertRecipe(c, brand, 'R-4');
      await c.query(`UPDATE recipe SET updated_at = '2000-01-01' WHERE id = $1`, [recipe]);
      const { rows } = await c.query<{ ok: boolean }>(
        `SELECT updated_at > '2000-01-01' AS ok FROM recipe WHERE id = $1`,
        [recipe],
      );
      expect(rows[0]!.ok).toBe(true);
    }));
});
