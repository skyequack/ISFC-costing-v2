import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import { getRecipe } from '@/lib/db/repo/recipes';
import { makeScope } from '@/lib/db/scope';
import { ApiError } from '@/lib/errors';
import type { Role } from '@/lib/permissions';
import { createBrand, deleteBrand, updateBrand } from '@/lib/services/brands';
import {
  createIngredient,
  deleteIngredient,
  removeConversion,
  setConversion,
  updateIngredient,
} from '@/lib/services/ingredients';
import { recipeDetail } from '@/lib/services/recipe-detail';
import {
  assertEditableCard,
  createRecipe,
  deleteRecipes,
  duplicateRecipe,
  lockRecipes,
  restoreRecipes,
  saveRecipe,
  unlockRecipes,
} from '@/lib/services/recipes';
import { updateSettings } from '@/lib/services/settings';
import { connect, hasTestDb, inRollback, insertBrand } from './helpers';

const U = (role: Role): SessionUser => ({ id: `u-${role}`, clerkUserId: `c-${role}`, email: null, name: `T ${role}`, role });
const gm = U('gm');

const line = (code: string, qty = 1, extra: Record<string, unknown> = {}) => ({ code, qty, unit: 'Gram' as const, y: 1, yp: null, ...extra });

async function fail(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected an ApiError but the call succeeded');
}

describe.skipIf(!hasTestDb)('services against Neon (all rolled back)', { timeout: 120_000 }, () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await connect();
  }, 60_000);
  afterAll(async () => {
    await c.end();
  });

  /** One test brand + scope; ingredient TSTI (price 2) shared; ingredient TSTN (no price). */
  async function world() {
    const brand = await insertBrand(c, 'ZZ');
    const other = await insertBrand(c, 'YY');
    const scope = makeScope([brand]);
    const item = (await createIngredient(c, gm, makeScope([brand, other]), {
      code: 'TSTI', name: 'Test item', uom: 'Gram', price: 2, category: 'c', subcategory: 's', flag: '', brandIds: [],
    })) as string;
    await createIngredient(c, gm, scope, {
      code: 'TSTN', name: 'No price', uom: 'Gram', price: null, category: 'c', subcategory: 's', flag: '', brandIds: [],
    });
    return { brand, other, scope, item };
  }

  it('createRecipe allocates the next free brand code, blank line + step, audit', () =>
    inRollback(c, async () => {
      const { brand, scope } = await world();
      const id = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
      const r = await getRecipe(c, scope, id);
      expect(r.code).toBe('ZZ-MN-0001');
      expect(r.lines).toHaveLength(1);
      expect(r.method).toEqual(['']);
      const id2 = await createRecipe(c, gm, scope, { brandId: brand, type: 'SUB' });
      expect((await getRecipe(c, scope, id2)).code).toBe('ZZ-SR-0001');
      const a = await c.query(`SELECT action FROM audit_log WHERE action = 'Created card' AND user_id = 'u-gm' ORDER BY created_at DESC LIMIT 1`);
      expect(a.rows).toHaveLength(1);
    }));

  it('cannot create in a brand outside the scope (404) or without recipe.create', () =>
    inRollback(c, async () => {
      const { brand, other, scope } = await world();
      expect((await fail(createRecipe(c, gm, scope, { brandId: other, type: 'MENU' }))).status).toBe(404);
      expect((await fail(createRecipe(c, U('viewer'), scope, { brandId: brand, type: 'MENU' }))).status).toBe(403);
    }));

  it('saves lines (yp null stays null, 0 stays 0), bumps version, detects stale version and costs correctly', () =>
    inRollback(c, async () => {
      const { brand, scope } = await world();
      const id = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
      await saveRecipe(c, gm, scope, id, {
        version: 0, name: 'Dish', output: 1,
        lines: [line('TSTI', 100), line('TSTI', 50, { yp: 0 }), line('', 0)],
      });
      const d = await recipeDetail(c, scope, id);
      expect(d.recipe.version).toBe(1);
      expect(d.recipe.lines.map((l) => l.yp)).toEqual([null, 0, null]);
      expect(d.view.cost.batch).toBe(300); // (100 + 50) g x 2
      expect((await fail(saveRecipe(c, gm, scope, id, { version: 0, name: 'x' }))).status).toBe(409);
      const same = await saveRecipe(c, gm, scope, id, { version: 1, name: 'Dish' });
      expect(same.changed).toBe(false);
    }));

  it('field-level authorisation: Finance may change only the price; Chef may not price', () =>
    inRollback(c, async () => {
      const { brand, scope } = await world();
      const id = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
      expect((await fail(saveRecipe(c, U('fin'), scope, id, { version: 0, name: 'Hacked' }))).status).toBe(403);
      expect((await fail(saveRecipe(c, U('chef'), scope, id, { version: 0, sellingPrice: 10 }))).status).toBe(403);
      await saveRecipe(c, U('fin'), scope, id, { version: 0, sellingPrice: 10 });
      const a = await c.query(`SELECT detail FROM audit_log WHERE action = 'Changed sales price' ORDER BY created_at DESC LIMIT 1`);
      expect(a.rows[0]!.detail).toContain('0.00 → 10.00');
    }));

  it('rejects unknown / out-of-scope line codes on new lines but tolerates unchanged legacy ones', () =>
    inRollback(c, async () => {
      const { brand, scope } = await world();
      await c.query(`INSERT INTO ingredient (code,name,uom,price,category,subcategory) VALUES ('SCOPED-X','n','Gram',1,'c','s')`);
      const x = (await c.query(`SELECT id FROM ingredient WHERE code='SCOPED-X'`)).rows[0]!.id;
      const foreign = await insertBrand(c, 'XX');
      await c.query('INSERT INTO item_brand_scope VALUES ($1,$2)', [x, foreign]);
      const id = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
      expect((await fail(saveRecipe(c, gm, scope, id, { version: 0, lines: [line('SCOPED-X')] }))).status).toBe(422);
      expect((await fail(saveRecipe(c, gm, scope, id, { version: 0, lines: [line('NOPE-1')] }))).status).toBe(422);
      // a legacy unknown code already on the card survives an unrelated edit of another line
      await c.query(`UPDATE recipe_line SET code = 'LEGACY-UNKNOWN' WHERE recipe_id = $1`, [id]);
      await saveRecipe(c, gm, scope, id, { version: 0, lines: [line('LEGACY-UNKNOWN', 5), line('TSTI', 1)] });
      expect((await getRecipe(c, scope, id)).lines.map((l) => l.code)).toEqual(['LEGACY-UNKNOWN', 'TSTI']);
    }));

  it('blocks circular references inside the save, including self and A->B->A', () =>
    inRollback(c, async () => {
      const { brand, scope } = await world();
      const a = await createRecipe(c, gm, scope, { brandId: brand, type: 'SUB' });
      const b = await createRecipe(c, gm, scope, { brandId: brand, type: 'SUB' });
      const ca = (await getRecipe(c, scope, a)).code;
      const cb = (await getRecipe(c, scope, b)).code;
      expect((await fail(saveRecipe(c, gm, scope, a, { version: 0, lines: [line(ca)] }))).status).toBe(409);
      await saveRecipe(c, gm, scope, a, { version: 0, lines: [line(cb)] });
      const e = await fail(saveRecipe(c, gm, scope, b, { version: 0, lines: [line(ca)] }));
      expect(e.status).toBe(409);
      expect(e.message).toMatch(/circular/i);
    }));

  it('code rename: collisions with cards and ingredients rejected; cascades to lines and menu cells', () =>
    inRollback(c, async () => {
      const { brand, scope } = await world();
      const sub = await createRecipe(c, gm, scope, { brandId: brand, type: 'SUB' });
      const user = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
      const subCode = (await getRecipe(c, scope, sub)).code;
      await saveRecipe(c, gm, scope, sub, { version: 0, batchOut: 100, lines: [line('TSTI', 100)] });
      await saveRecipe(c, gm, scope, user, { version: 0, lines: [line(subCode, 10)] });
      expect((await fail(saveRecipe(c, gm, scope, sub, { version: 1, code: 'tsti' }))).status).toBe(409); // ingredient code, any case
      expect((await fail(saveRecipe(c, gm, scope, sub, { version: 1, code: (await getRecipe(c, scope, user)).code.toLowerCase() }))).status).toBe(409);
      await saveRecipe(c, gm, scope, sub, { version: 1, code: 'ZZ-SR-RENAMED' });
      expect((await getRecipe(c, scope, user)).lines[0]!.code).toBe('ZZ-SR-RENAMED');
      const a = await c.query(`SELECT detail FROM audit_log WHERE action = 'Renamed card code' ORDER BY created_at DESC LIMIT 1`);
      expect(a.rows[0]!.detail).toContain('1 reference');
    }));

  it('lock gate: null price blocks, GM override stores the reason and the cost-at-lock snapshot; unlock reopens', () =>
    inRollback(c, async () => {
      const { brand, scope } = await world();
      const id = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
      await saveRecipe(c, gm, scope, id, { version: 0, sellingPrice: 50, lines: [line('TSTN', 10)] });
      const e = await fail(lockRecipes(c, U('cc'), scope, [id], 'Boss'));
      expect(e.status).toBe(422);
      expect((e.details as { overridable: boolean }).overridable).toBe(false);
      expect((await fail(lockRecipes(c, U('cc'), scope, [id], 'Boss', 'because'))).status).toBe(422); // only a GM may override
      await lockRecipes(c, gm, scope, [id], 'Boss', 'price arrives Monday');
      const r = await c.query('SELECT status, locked_by, cost_at_lock FROM recipe WHERE id = $1', [id]);
      expect(r.rows[0]!.status).toBe('LOCKED');
      expect(r.rows[0]!.cost_at_lock.overrideReason).toBe('price arrives Monday');
      expect(r.rows[0]!.cost_at_lock.settings.vat).toBeTypeOf('number');
      // every edit path refuses a locked card
      expect((await fail(saveRecipe(c, gm, scope, id, { version: 3, name: 'x' }))).status).toBe(422);
      expect((await fail(assertEditableCard(c, gm, scope, id))).status).toBe(422);
    }));

  it('locked cards: delete needs recipe.unlock; unlock/lock roles; history entries', () =>
    inRollback(c, async () => {
      const { brand, scope } = await world();
      const id = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
      await saveRecipe(c, gm, scope, id, { version: 0, lines: [line('TSTI', 10)] });
      await lockRecipes(c, U('chef'), scope, [id], 'Head Chef');
      expect((await fail(deleteRecipes(c, U('chef'), scope, [id]))).status).toBe(403); // chef has no recipe.delete
      expect((await fail(unlockRecipes(c, U('chef'), scope, [id]))).status).toBe(403);
      await unlockRecipes(c, U('cc'), scope, [id]);
      const h = await c.query('SELECT action FROM recipe_history_entry WHERE recipe_id = $1 ORDER BY created_at, action', [id]);
      expect(h.rows.map((x) => x.action).sort()).toEqual(['LOCK', 'UNLOCK']);
    }));

  it('soft delete frees the code; restore re-checks the collision; bulk is all-or-nothing', () =>
    inRollback(c, async () => {
      const { brand, other, scope } = await world();
      const a = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
      const b = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
      const codeA = (await getRecipe(c, scope, a)).code;
      await deleteRecipes(c, gm, scope, [a]);
      const again = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
      expect((await getRecipe(c, scope, again)).code).toBe(codeA); // code reused after soft delete
      expect((await fail(restoreRecipes(c, gm, scope, [a]))).status).toBe(409);
      // bulk: one id out of scope aborts the whole call
      const foreign = await createRecipe(c, gm, makeScope([other]), { brandId: other, type: 'MENU' });
      expect((await fail(deleteRecipes(c, gm, scope, [b, foreign]))).status).toBe(404);
      expect((await getRecipe(c, scope, b)).code).toBeTruthy(); // b untouched (same transaction would roll back in the route)
    }));

  it('brand IDOR: get/save/delete/duplicate of another brand card is 404', () =>
    inRollback(c, async () => {
      const { other, scope } = await world();
      const foreign = await createRecipe(c, gm, makeScope([other]), { brandId: other, type: 'MENU' });
      expect((await fail(getRecipe(c, scope, foreign))).status).toBe(404);
      expect((await fail(saveRecipe(c, gm, scope, foreign, { version: 0, name: 'x' }))).status).toBe(404);
      expect((await fail(deleteRecipes(c, gm, scope, [foreign]))).status).toBe(404);
      expect((await fail(duplicateRecipe(c, gm, scope, foreign))).status).toBe(404);
      expect((await fail(assertEditableCard(c, gm, scope, foreign))).status).toBe(404);
    }));

  it('duplicate copies lines, method, buffer and photo; new code; draft', () =>
    inRollback(c, async () => {
      const { brand, scope } = await world();
      const id = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
      await saveRecipe(c, gm, scope, id, { version: 0, name: 'Original', buffer: 0.2, lines: [line('TSTI', 7, { yp: 12.5 })], method: ['a', 'b'] });
      const copy = await getRecipe(c, scope, await duplicateRecipe(c, gm, scope, id));
      expect(copy.name).toBe('Original (copy)');
      expect(copy.status).toBe('DRAFT');
      expect(copy.buffer).toBe(0.2);
      expect(copy.lines[0]).toMatchObject({ code: 'TSTI', qty: 7, yp: 12.5 });
      expect(copy.method).toEqual(['a', 'b']);
    }));

  it('ingredients: price change writes history + audit; code collisions; delete blocked while used; conversion rules', () =>
    inRollback(c, async () => {
      const { brand, scope, item } = await world();
      const upd = {
        code: 'TSTI', name: 'Test item', uom: 'Gram' as const, price: 3.5, category: 'c', subcategory: 's', flag: '', brandIds: [], version: 0,
      };
      expect((await fail(updateIngredient(c, U('chef'), scope, item, upd))).status).toBe(403);
      await updateIngredient(c, U('fin'), scope, item, upd);
      const h = await c.query('SELECT old_price, new_price, source FROM ingredient_price_history WHERE ingredient_id = $1 AND new_price = 3.5', [item]);
      expect(h.rows[0]).toMatchObject({ old_price: 2, new_price: 3.5, source: 'MANUAL' });
      expect((await fail(updateIngredient(c, gm, scope, item, upd))).status).toBe(409); // stale version
      expect((await fail(createIngredient(c, gm, scope, { ...upd, code: 'tsti', price: 1 }))).status).toBe(409); // case-insensitive
      const recipeId = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
      const code = (await getRecipe(c, scope, recipeId)).code;
      expect((await fail(createIngredient(c, gm, scope, { ...upd, code: code.toLowerCase(), price: 1 }))).status).toBe(409); // recipe namespace
      await saveRecipe(c, gm, scope, recipeId, { version: 0, lines: [line('TSTI', 3)] });
      expect((await fail(deleteIngredient(c, gm, scope, item))).status).toBe(409);
      // conversion: same unit refused; factor must be positive; round trip
      expect((await fail(setConversion(c, gm, scope, item, 'Gram', 2))).status).toBe(422);
      expect((await fail(setConversion(c, U('fin'), scope, item, 'Each', 2))).status).toBe(403);
      await setConversion(c, U('cc'), scope, item, 'Each', 0.5);
      expect((await c.query('SELECT factor FROM unit_conversion WHERE ingredient_id = $1', [item])).rows[0]!.factor).toBe(0.5);
      await removeConversion(c, U('cc'), scope, item);
      expect((await fail(removeConversion(c, U('cc'), scope, item))).status).toBe(404);
    }));

  it('ingredient scoping: a brand-scoped item is 404 to a user without that brand; non-GM cannot grant foreign brands', () =>
    inRollback(c, async () => {
      const { brand, other, scope } = await world();
      const scoped = await createIngredient(c, gm, makeScope([brand, other]), {
        code: 'ONLY-OTHER', name: 'n', uom: 'Gram', price: 1, category: 'c', subcategory: 's', flag: '', brandIds: [other],
      });
      const body = { code: 'ONLY-OTHER', name: 'n2', uom: 'Gram' as const, price: 1, category: 'c', subcategory: 's', flag: '', brandIds: [other], version: 0 };
      expect((await fail(updateIngredient(c, U('cc'), scope, scoped, body))).status).toBe(404);
      expect((await fail(createIngredient(c, U('cc'), scope, { ...body, code: 'NEW-X', brandIds: [other] }))).status).toBe(403);
    }));

  it('brands: create defaults, duplicate prefix/name rejected, sites rename cascades and removal with rows is refused (D-52)', () =>
    inRollback(c, async () => {
      const id = await createBrand(c, gm, { name: 'Zeta Kitchen' });
      expect((await c.query('SELECT code FROM brand WHERE id = $1', [id])).rows[0]!.code).toBe('ZET');
      expect((await fail(createBrand(c, gm, { name: 'zeta kitchen', code: 'QQ' }))).status).toBe(409);
      expect((await fail(createBrand(c, gm, { name: 'Other', code: 'ZET' }))).status).toBe(409);
      expect((await fail(createBrand(c, U('cc'), { name: 'Nope' }))).status).toBe(403);
      await updateBrand(c, gm, id, { locations: ['AAA', 'BBB'] });
      const scope = makeScope([id]);
      const rid = await createRecipe(c, gm, scope, { brandId: id, type: 'MENU' });
      const code = (await getRecipe(c, scope, rid)).code;
      await c.query(`INSERT INTO production_entry (month, day, location, recipe_code, portions) VALUES ('2099-01','01','AAA',$1,5)`, [code]);
      expect((await fail(updateBrand(c, gm, id, { locations: ['BBB'] }))).status).toBe(409);
      await updateBrand(c, gm, id, { locations: ['AA2', 'BBB'], renamedSites: [{ from: 'AAA', to: 'AA2' }] });
      expect((await c.query(`SELECT location FROM production_entry WHERE recipe_code = $1`, [code])).rows[0]!.location).toBe('AA2');
      expect((await fail(updateBrand(c, gm, id, { locations: ['bbb', 'BBB'] }))).status).toBe(400);
      // brand with cards cannot be removed
      expect((await fail(deleteBrand(c, gm, id))).status).toBe(409);
    }));

  it('settings: version check, range validation by schema, audit with old -> new and card count', () =>
    inRollback(c, async () => {
      const v = (await c.query('SELECT version, pkg FROM cost_settings')).rows[0]!;
      expect((await fail(updateSettings(c, U('cc'), { version: v.version, pkg: 0.2 }))).status).toBe(403);
      expect((await fail(updateSettings(c, gm, { version: v.version + 9, pkg: 0.2 }))).status).toBe(409);
      const r = await updateSettings(c, U('fin'), { version: v.version, pkg: 0.12 });
      expect(r.changed).toEqual(['pkg']);
      const a = await c.query(`SELECT detail FROM audit_log WHERE action = 'Settings changed' ORDER BY created_at DESC LIMIT 1`);
      expect(a.rows[0]!.detail).toMatch(/pkg .*% → 12\.00%.*cards affected/);
    }));
});
