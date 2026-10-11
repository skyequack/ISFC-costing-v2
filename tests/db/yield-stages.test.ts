import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import { getRecipe } from '@/lib/db/repo/recipes';
import { makeScope } from '@/lib/db/scope';
import { applyRestore, backupSchema, buildBackupCore } from '@/lib/services/backup';
import { buildExport, exportQuery } from '@/lib/services/exports';
import { commitRecipeImport, previewRecipeImport, type RecipeImportIn } from '@/lib/services/import-recipes';
import { createIngredient } from '@/lib/services/ingredients';
import { createRecipe, duplicateRecipe, saveRecipe } from '@/lib/services/recipes';
import { connect, hasTestDb, inRollback, insertBrand } from './helpers';

vi.mock('@/lib/db/catalog-cache', () => ({ getCatalog: vi.fn(), CATALOG_TAG: 'catalog' }));

const gm: SessionUser = { id: 'u-gm', clerkUserId: 'c-gm', email: null, name: 'T gm', role: 'gm' };
const line = (code: string, qty: number, extra: Record<string, unknown> = {}) => ({
  code,
  qty,
  unit: 'Gram' as const,
  y: 1,
  yp: null,
  ...extra,
});

describe.skipIf(!hasTestDb)('three-stage line yield (D-70, D-85)', { timeout: 280_000 }, () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await connect();
  }, 60_000);
  afterAll(async () => {
    await c.end();
  });

  async function world() {
    const brand = await insertBrand(c, 'YS');
    const scope = makeScope([brand]);
    await createIngredient(c, gm, scope, {
      code: 'YS-ING',
      name: 'Stage item',
      uom: 'Gram',
      price: 2,
      category: 'c',
      subcategory: 's',
      flag: '',
      brandIds: [],
    });
    const id = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
    return { brand, scope, id };
  }
  const stored = (id: string) =>
    c
      .query(
        "SELECT y, y_thaw, y_cut, y_cook FROM recipe_line WHERE recipe_id = $1 AND code <> '' ORDER BY sort_order",
        [id],
      )
      .then((r) => r.rows);

  it('the service writes y = thaw x cut x cook, ignores a y sent with stages, and a blank stage counts as 1', () =>
    inRollback(c, async () => {
      const { scope, id } = await world();
      await saveRecipe(c, gm, scope, id, {
        version: 0,
        lines: [
          line('YS-ING', 100, { y: 0.123, yThaw: 0.9, yCut: 0.8, yCook: 0.5 }),
          line('YS-ING', 50, { y: 0.5, yCut: 0.5 }), // one stage only
          line('YS-ING', 10, { y: 0.8 }), // no stages: its own y is kept
        ],
      });
      const rows = await stored(id);
      expect(rows[0]).toEqual({ y: 0.9 * 0.8 * 0.5, y_thaw: 0.9, y_cut: 0.8, y_cook: 0.5 });
      expect(rows[1]).toEqual({ y: 0.5, y_thaw: null, y_cut: 0.5, y_cook: null });
      expect(rows[2]).toEqual({ y: 0.8, y_thaw: null, y_cut: null, y_cook: null });
      const r = await getRecipe(c, scope, id);
      expect(r.lines.filter((l) => l.code).map((l) => [l.yThaw, l.yCut, l.yCook])).toEqual([
        [0.9, 0.8, 0.5],
        [null, 0.5, null],
        [null, null, null],
      ]);
    }));

  it('saving the same stages again is a no-op; changing a stage is a change and is audited as a yield change', () =>
    inRollback(c, async () => {
      const { scope, id } = await world();
      const mk = (cook: number) => [line('YS-ING', 100, { yThaw: 0.9, yCut: 0.8, yCook: cook })];
      await saveRecipe(c, gm, scope, id, { version: 0, lines: mk(0.5) });
      expect((await saveRecipe(c, gm, scope, id, { version: 1, lines: mk(0.5) })).changed).toBe(false);
      const r = await saveRecipe(c, gm, scope, id, { version: 1, lines: mk(0.6) });
      expect(r.changed).toBe(true);
      const a = await c.query(`SELECT 1 FROM audit_log WHERE action = 'Changed a line yield'`);
      expect(a.rowCount).toBeGreaterThanOrEqual(1);
    }));

  it('clearing the stages keeps the y the editor sends; a product outside (0,10] and a bad stage are refused', async () => {
    const { lineIn } = await import('@/lib/validation/common');
    expect(lineIn.safeParse(line('A', 1, { yThaw: 5, yCut: 5 })).success).toBe(false); // 25
    expect(lineIn.safeParse(line('A', 1, { yThaw: 0 })).success).toBe(false);
    expect(lineIn.safeParse(line('A', 1, { yCook: -1 })).success).toBe(false);
    expect(lineIn.safeParse(line('A', 1, { yThaw: 2, yCut: 5 })).success).toBe(true); // exactly 10
    await inRollback(c, async () => {
      const { scope, id } = await world();
      await saveRecipe(c, gm, scope, id, { version: 0, lines: [line('YS-ING', 1, { yThaw: 0.5, yCut: 0.5 })] });
      await saveRecipe(c, gm, scope, id, { version: 1, lines: [line('YS-ING', 1, { y: 0.25 })] });
      expect((await stored(id))[0]).toEqual({ y: 0.25, y_thaw: null, y_cut: null, y_cook: null });
    });
  });

  it('the database refuses a stage outside (0,10]', () =>
    inRollback(c, async () => {
      const { id } = await world();
      await c.query('SAVEPOINT s');
      await expect(
        c.query(
          `INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit, y, y_thaw) VALUES ($1,9,'YS-ING',1,'Gram',1,0)`,
          [id],
        ),
      ).rejects.toThrow();
      await c.query('ROLLBACK TO SAVEPOINT s');
    }));

  it('duplicate copies the stages', () =>
    inRollback(c, async () => {
      const { scope, id } = await world();
      await saveRecipe(c, gm, scope, id, { version: 0, lines: [line('YS-ING', 1, { yThaw: 0.9, yCook: 0.7 })] });
      const copy = await duplicateRecipe(c, gm, scope, id);
      expect((await stored(copy))[0]).toEqual({ y: 0.9 * 0.7, y_thaw: 0.9, y_cut: null, y_cook: 0.7 });
    }));

  it('backup carries the stages; a restore recomputes y from them; an old file restores with no stages', () =>
    inRollback(c, async () => {
      const { scope, id } = await world();
      await saveRecipe(c, gm, scope, id, { version: 0, lines: [line('YS-ING', 100, { yThaw: 0.9, yCut: 0.8 })] });
      const code = (await getRecipe(c, scope, id)).code;
      const core = await buildBackupCore(c, gm);
      const card = core.recipes.find((r) => r.code === code)!;
      expect(card.lines[0]).toMatchObject({ y: 0.9 * 0.8, yThaw: 0.9, yCut: 0.8, yCook: null });

      const slim = {
        ...core,
        ingredients: core.ingredients.filter((i) => i.code === 'YS-ING'),
        recipes: [{ ...card, lines: [{ ...card.lines[0]!, y: 0.123 }] }], // a tampered y: stages win
        menus: [],
        menuPax: [],
        production: [],
        clients: [],
        stockCounts: undefined,
        receipts: undefined,
      };
      await applyRestore(c, gm, backupSchema.parse(JSON.parse(JSON.stringify(slim))), 'stages.json');
      expect((await stored(id))[0]).toEqual({ y: 0.9 * 0.8, y_thaw: 0.9, y_cut: 0.8, y_cook: null });

      const old = JSON.parse(JSON.stringify(slim)) as typeof slim;
      for (const l of old.recipes[0]!.lines) {
        const x = l as Record<string, unknown>;
        delete x.yThaw;
        delete x.yCut;
        delete x.yCook;
      }
      await applyRestore(c, gm, backupSchema.parse(old), 'old.json');
      expect((await stored(id))[0]!.y_thaw).toBeNull();

      // stages whose product is out of range are refused before anything is written
      const bad = JSON.parse(JSON.stringify(slim)) as typeof slim;
      Object.assign(bad.recipes[0]!.lines[0]!, { yThaw: 5, yCut: 5, yCook: null });
      expect(backupSchema.safeParse(bad).success).toBe(false);
    }));

  describe('sheets (D-85)', () => {
    const card = (code: string, lines: RecipeImportIn['cards'][number]['lines']) => ({
      brand: '',
      code,
      name: 'Imported',
      cat: '',
      type: '',
      out: null,
      bout: null,
      buom: '' as const,
      price: null,
      buffer: null,
      lines,
      method: [],
      rows: [],
    });
    const ln = (extra: Partial<RecipeImportIn['cards'][number]['lines'][number]> = {}) => ({
      code: 'YS-ING',
      qty: 100,
      unit: 'Gram' as const,
      y: 1,
      yp: null,
      ...extra,
    });
    const run = async (scope: ReturnType<typeof makeScope>, brand: string, cards: RecipeImportIn['cards']) => {
      const input: RecipeImportIn = {
        cards,
        defaultBrandId: brand,
        takePrice: false,
        allowUpdate: true,
        grant: true,
        file: 'f.xlsx',
      };
      const plan = await previewRecipeImport(c, gm, scope, input);
      await commitRecipeImport(c, gm, scope, { ...input, hash: plan.hash });
    };

    it('stage columns set the stages and y; without them stages stay while Yield % matches and clear when it differs', () =>
      inRollback(c, async () => {
        const { brand, scope, id } = await world();
        const code = (await getRecipe(c, scope, id)).code;
        // the file has the columns
        await run(scope, brand, [card(code, [ln({ stages: { yThaw: 0.9, yCut: null, yCook: 0.5 } })])]);
        expect((await stored(id))[0]).toEqual({ y: 0.9 * 0.5, y_thaw: 0.9, y_cut: null, y_cook: 0.5 });
        // no stage columns, Yield % as the export would show it (45): the stored stages stay
        await run(scope, brand, [card(code, [ln({ y: 0.45 })])]);
        expect((await stored(id))[0]).toEqual({ y: 0.9 * 0.5, y_thaw: 0.9, y_cut: null, y_cook: 0.5 });
        // no stage columns and a different Yield %: the sheet wins and the stages go
        await run(scope, brand, [card(code, [ln({ y: 0.7 })])]);
        expect((await stored(id))[0]).toEqual({ y: 0.7, y_thaw: null, y_cut: null, y_cook: null });
        // columns present but blank: not set
        await run(scope, brand, [card(code, [ln({ y: 0.6, stages: { yThaw: null, yCut: null, yCook: null } })])]);
        expect((await stored(id))[0]).toEqual({ y: 0.6, y_thaw: null, y_cut: null, y_cook: null });
      }));

    it('the recipe-lines export carries the three columns, and a card with no stages leaves them blank', () =>
      inRollback(c, async () => {
        const { scope, id } = await world();
        await saveRecipe(c, gm, scope, id, {
          version: 0,
          lines: [line('YS-ING', 100, { yThaw: 0.9, yCook: 0.725 }), line('YS-ING', 5)],
        });
        const code = (await getRecipe(c, scope, id)).code;
        const { buildCtx } = await import('@/lib/screens/ctx');
        const ctx = await buildCtx(c, gm);
        const out = await buildExport(c, gm, 'recipes-data', exportQuery.parse({}), ctx);
        const head = out.rows[0] as string[];
        expect(head.slice(-3)).toEqual(['Thaw %', 'Cut %', 'Cook %']);
        const mine = out.rows.filter((r) => (r as unknown[])[1] === code || (r as unknown[])[9] === 'YS-ING');
        const first = out.rows.find((r) => (r as unknown[])[1] === code) as unknown[];
        expect(first.slice(-3)).toEqual(['90', '', '72.5']);
        expect(mine.length).toBeGreaterThanOrEqual(2);
      }));
  });
});
