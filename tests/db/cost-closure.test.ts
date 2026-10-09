import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import { loadCatalog, loadCostClosure } from '@/lib/db/catalog';
import { getRecipe } from '@/lib/db/repo/recipes';
import { makeScope } from '@/lib/db/scope';
import { buildCardView, toCostRecipe } from '@/lib/services/card-view';
import { createIngredient, setConversion } from '@/lib/services/ingredients';
import { recipeDetail } from '@/lib/services/recipe-detail';
import { createRecipe, lockRecipes, saveRecipe } from '@/lib/services/recipes';
import { connect, hasTestDb, inRollback, insertBrand } from './helpers';

const gm: SessionUser = { id: 'u-gm', clerkUserId: 'c-gm', email: null, name: 'T gm', role: 'gm' };

/** The card costed from the whole catalog (old path) and from its cost closure (new path) must be identical, bit for bit. */
async function sameCosting(c: pg.Client, scope: ReturnType<typeof makeScope>, id: string) {
  const full = await loadCatalog(c);
  const rec = toCostRecipe(await getRecipe(c, scope, id));
  const codes = [...new Set(rec.lines.map((l) => l.code).filter(Boolean))];
  const { catalog } = await loadCostClosure(c, codes, id);
  expect(buildCardView(catalog, rec)).toEqual(buildCardView(full, rec));
  expect(catalog.settings).toEqual(full.settings);
}

describe.skipIf(!hasTestDb)(
  'cost closure equals the full catalog (read-only on seed, rolled back otherwise)',
  {
    timeout: 900_000,
  },
  () => {
    let c: pg.Client;
    beforeAll(async () => {
      c = await connect();
    }, 60_000);
    afterAll(async () => {
      await c.end();
    });

    it('every live seed card is costed identically, view and cost issues included', async () => {
      const full = await loadCatalog(c);
      const all = full.context.recipes;
      expect(all.size).toBeGreaterThan(0);
      let n = 0;
      for (const rec of all.values()) {
        const codes = [...new Set(rec.lines.map((l) => l.code).filter(Boolean))];
        const { catalog } = await loadCostClosure(c, codes, rec.id as string);
        const a = buildCardView(catalog, rec);
        const b = buildCardView(full, rec);
        if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`closure costing differs for ${rec.code}`);
        expect(a).toEqual(b);
        n++;
      }
      expect(n).toBe(all.size);
    });

    it('edge cases: cycle, self reference, missing price, missing conversion, unknown code, blank row, deleted sub-recipe', () =>
      inRollback(c, async () => {
        const brand = await insertBrand(c, 'ZZ');
        const scope = makeScope([brand]);
        const mk = async (code: string, price: number | null, uom: 'Gram' | 'Each' = 'Gram') =>
          createIngredient(c, gm, scope, {
            code,
            name: code,
            uom,
            price,
            category: 'c',
            subcategory: 's',
            flag: '',
            brandIds: [],
          });
        await mk('ZI1', 2);
        await mk('ZI2', null); // no price
        const each = (await mk('ZI3', 5, 'Each')) as string; // used in Gram: needs the conversion below
        const pack = (await mk('ZPK', 1)) as string;
        await c.query(`UPDATE ingredient SET category = 'Non-Food' WHERE id = $1`, [pack]);
        await setConversion(c, gm, scope, each, 'Gram', 0.25);

        const sub = await createRecipe(c, gm, scope, { brandId: brand, type: 'SUB' });
        const menu = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
        const deadSub = await createRecipe(c, gm, scope, { brandId: brand, type: 'SUB' });
        const subCode = (await getRecipe(c, scope, sub)).code;
        const deadCode = (await getRecipe(c, scope, deadSub)).code;
        const l = (code: string, qty: number, unit = 'Gram', yp: number | null = null) => ({
          code,
          qty,
          unit: unit as 'Gram',
          y: 1,
          yp,
        });
        await saveRecipe(c, gm, scope, sub, {
          version: 0,
          output: 1,
          subQty: 100,
          lines: [l('ZI1', 0.1 + 0.2), l('ZI2', 5, 'Gram', 0)],
        });
        await saveRecipe(c, gm, scope, deadSub, { version: 0, lines: [l('ZI1', 7)] });
        await saveRecipe(c, gm, scope, menu, {
          version: 0,
          lines: [l(subCode, 3), l('ZI3', 2), l('ZI1', 1 / 3, 'Gram', 12.5), l('ZPK', 1), l('', 0), l(deadCode, 1)],
        });
        // an unknown code can only get in around the service (an ingredient deleted later, legacy data)
        await c.query(
          `INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit, y) VALUES ($1, 20, 'NOPE-1', 4, 'Gram', 1)`,
          [menu],
        );
        await c.query(`UPDATE recipe SET deleted_at = now() WHERE id = $1`, [deadSub]);
        await sameCosting(c, scope, menu);
        expect((await recipeDetail(c, scope, menu)).packaging).toEqual(['ZPK']);

        // self reference and a cycle, written directly (the service refuses them)
        await c.query(
          `INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit, y) VALUES ($1, 9, $2, 1, 'Gram', 1)`,
          [sub, subCode],
        );
        await sameCosting(c, scope, sub);
        await c.query(
          `INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit, y) VALUES ($1, 10, $2, 1, 'Gram', 1)`,
          [sub, (await getRecipe(c, scope, menu)).code],
        );
        await sameCosting(c, scope, menu);
        await sameCosting(c, scope, sub);
      }));

    it('getRecipe returns head, ordered lines, method and lock history as before (dates are Dates)', () =>
      inRollback(c, async () => {
        const brand = await insertBrand(c, 'ZZ');
        const scope = makeScope([brand]);
        await createIngredient(c, gm, scope, {
          code: 'ZI1',
          name: 'x',
          uom: 'Gram',
          price: 2,
          category: 'c',
          subcategory: 's',
          flag: '',
          brandIds: [],
        });
        const id = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
        await saveRecipe(c, gm, scope, id, {
          version: 0,
          name: 'Dish',
          method: ['one', 'two ½', ''],
          lines: [
            { code: 'ZI1', qty: 2, unit: 'Gram', y: 1, yp: null },
            { code: 'ZI1', qty: 1.5, unit: 'Gram', y: 0.8, yp: 0 },
          ],
        });
        await lockRecipes(c, gm, scope, [id], 'Chef', 'closure test');
        const r = await getRecipe(c, scope, id);
        expect(r.lines.map((x) => [x.sortOrder, x.qty, x.y, x.yp])).toEqual([
          [0, 2, 1, null],
          [1, 1.5, 0.8, 0],
        ]);
        expect(r.method).toEqual(['one', 'two ½', '']);
        const direct = await c.query(
          'SELECT action, who, created_at FROM recipe_history_entry WHERE recipe_id = $1 ORDER BY created_at',
          [id],
        );
        expect(r.history.map((h) => [h.action, h.who, h.at.getTime()])).toEqual(
          direct.rows.map((h) => [h.action, h.who, (h.created_at as Date).getTime()]),
        );
        for (const h of r.history) expect(h.at).toBeInstanceOf(Date);
      }));
  },
);
