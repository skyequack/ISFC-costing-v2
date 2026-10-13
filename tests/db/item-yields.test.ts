import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import { listIngredients } from '@/lib/db/repo/ingredients';
import { makeScope } from '@/lib/db/scope';
import type { ApiError } from '@/lib/errors';
import type { Role } from '@/lib/permissions';
import { applyRestore, backupSchema, buildBackupCore } from '@/lib/services/backup';
import { buildExport, exportQuery } from '@/lib/services/exports';
import { commitItemImport, itemImportIn, previewItemImport } from '@/lib/services/import-items';
import { createIngredient, setIngredientYields, updateIngredient } from '@/lib/services/ingredients';
import { ingredientIn } from '@/lib/validation/common';
import { connect, expectFails, hasTestDb, inRollback, insertBrand } from './helpers';

vi.mock('@/lib/db/catalog-cache', () => ({ getCatalog: vi.fn(), CATALOG_TAG: 'catalog' }));

const U = (role: Role): SessionUser => ({
  id: `u-${role}`,
  clerkUserId: `c-${role}`,
  email: null,
  name: `T ${role}`,
  role,
});
const gm = U('gm');
const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected a failure');
};

describe.skipIf(!hasTestDb)('raw material default yields (D-93, D-94)', { timeout: 280_000 }, () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await connect();
  }, 60_000);
  afterAll(async () => {
    await c.end();
  });

  const body = (code: string, extra: Record<string, unknown> = {}) =>
    ingredientIn.parse({ code, name: `Name ${code}`, uom: 'Gram', price: 2, ...extra });
  const stored = (code: string) =>
    c.query('SELECT y_thaw, y_cut, y_cook, version FROM ingredient WHERE code = $1', [code]).then((r) => r.rows[0]!);
  const idOf = (code: string) =>
    c.query('SELECT id FROM ingredient WHERE code = $1', [code]).then((r) => r.rows[0]!.id as string);
  const lastYieldAudit = () =>
    c
      .query(`SELECT detail FROM audit_log WHERE action = 'Changed default yields' ORDER BY created_at DESC LIMIT 1`)
      .then((r) => r.rows[0]!.detail as string);

  it('existing rows have no default, and the CHECK refuses 0, negatives and above 10', () =>
    inRollback(c, async () => {
      await c.query(
        `INSERT INTO ingredient (code, name, uom, price, category, subcategory, flag) VALUES ('YC-0','x','Gram',1,'c','s','')`,
      );
      expect(await stored('YC-0')).toMatchObject({ y_thaw: null, y_cut: null, y_cook: null });
      const ins = `INSERT INTO ingredient (code, name, uom, price, category, subcategory, flag, y_thaw) VALUES ('YC-X','x','Gram',1,'c','s','',$1)`;
      for (const bad of [0, -0.5, 10.5]) await expectFails(c, ins, [bad], /ingredient_stage_range/);
    }));

  it('create stores the stages (0 becomes null, doubles are bit-exact); the item list only carries them when asked', () =>
    inRollback(c, async () => {
      await createIngredient(c, gm, makeScope([]), body('YC-1', { yThaw: 0.95, yCut: 0, yCook: 0.1 + 0.2 }));
      expect(await stored('YC-1')).toMatchObject({ y_thaw: 0.95, y_cut: null, y_cook: 0.1 + 0.2 });
      const brand = await insertBrand(c, 'YC');
      const scope = makeScope([brand]);
      expect((await listIngredients(c, scope)).find((i) => i.code === 'YC-1')).not.toHaveProperty('yThaw');
      expect((await listIngredients(c, scope, true)).find((i) => i.code === 'YC-1')).toMatchObject({
        yThaw: 0.95,
        yCut: null,
        yCook: 0.1 + 0.2,
      });
    }));

  it('update: absent keeps, null clears, a number sets, and the change is audited', () =>
    inRollback(c, async () => {
      const scope = makeScope([]);
      await createIngredient(c, gm, scope, body('YC-2', { yThaw: 0.9, yCut: 0.8 }));
      const id = await idOf('YC-2');
      let v = (await stored('YC-2')).version as number;
      // a price-only edit (stages absent) must not wipe them
      await updateIngredient(c, gm, scope, id, { ...body('YC-2', { price: 3 }), version: v });
      expect(await stored('YC-2')).toMatchObject({ y_thaw: 0.9, y_cut: 0.8, y_cook: null });
      v++;
      await updateIngredient(c, gm, scope, id, { ...body('YC-2', { price: 3, yThaw: null, yCook: 0.5 }), version: v });
      expect(await stored('YC-2')).toMatchObject({ y_thaw: null, y_cut: 0.8, y_cook: 0.5 });
      expect(await lastYieldAudit()).toBe('YC-2: thaw 90% · cut 80% · cook — → thaw — · cut 80% · cook 50%');
    }));

  it('Save to raw material: needs items.edit, finds by code, bumps the version, audits, and is a no-op when unchanged', () =>
    inRollback(c, async () => {
      const scope = makeScope([]);
      await createIngredient(c, gm, scope, body('YC-3'));
      const v0 = (await stored('YC-3')).version as number;
      expect((await fail(setIngredientYields(c, U('chef'), scope, { code: 'YC-3', yThaw: 0.9 }))).status).toBe(403);
      expect((await fail(setIngredientYields(c, gm, scope, { code: 'NOPE', yThaw: 0.9 }))).status).toBe(404);
      await setIngredientYields(c, U('cc'), scope, { code: 'YC-3', yThaw: 0.9, yCook: 0.7 });
      expect(await stored('YC-3')).toMatchObject({ y_thaw: 0.9, y_cut: null, y_cook: 0.7, version: v0 + 1 });
      expect(await lastYieldAudit()).toBe('YC-3: thaw — · cut — · cook — → thaw 90% · cut — · cook 70%');
      await setIngredientYields(c, gm, scope, { code: 'YC-3', yThaw: 0.9, yCook: 0.7 });
      expect((await stored('YC-3')).version).toBe(v0 + 1);
      // a change below the 0.01-point display rounding is still saved
      await setIngredientYields(c, gm, scope, { code: 'YC-3', yThaw: 0.9000001, yCook: 0.7 });
      expect(await stored('YC-3')).toMatchObject({ y_thaw: 0.9000001, version: v0 + 2 });
    }));

  it('a user cannot save yields onto a raw material scoped to brands they cannot see', () =>
    inRollback(c, async () => {
      const mine = await insertBrand(c, 'YM');
      const other = await insertBrand(c, 'YO');
      await createIngredient(c, gm, makeScope([other]), body('YC-4', { brandIds: [other] }));
      const err4 = await fail(setIngredientYields(c, U('cc'), makeScope([mine]), { code: 'YC-4', yThaw: 0.9 }));
      expect(err4.status).toBe(404);
      await createIngredient(c, gm, makeScope([mine, other]), body('YC-5', { brandIds: [mine, other] }));
      const err5 = await fail(setIngredientYields(c, U('cc'), makeScope([mine]), { code: 'YC-5', yThaw: 0.9 }));
      expect(err5.status).toBe(403);
    }));

  it('price-list import: blank leaves the default, null (0) clears it, a number sets it', () =>
    inRollback(c, async () => {
      const scope = makeScope([]);
      await createIngredient(c, gm, scope, body('YC-6', { yThaw: 0.9, yCut: 0.8, yCook: 0.7 }));
      const row = (extra: Record<string, unknown>) => ({
        code: 'YC-6',
        name: '',
        uom: 'Gram',
        price: null,
        cat: '',
        sub: '',
        line: 2,
        ...extra,
      });
      const run = async (rows: ReturnType<typeof row>[]) => {
        const input = itemImportIn.parse({ rows });
        const plan = await previewItemImport(c, gm, scope, input);
        await commitItemImport(c, gm, scope, { ...input, hash: plan.hash });
        return plan;
      };
      const none = await run([row({})]);
      expect(none.rows[0]!.action).toBe('same');
      expect(await stored('YC-6')).toMatchObject({ y_thaw: 0.9, y_cut: 0.8, y_cook: 0.7 });
      const plan = await run([row({ yThaw: null, yCook: 0.5 })]); // thaw cleared (0 in the sheet), cut blank, cook set
      expect(plan.rows[0]!.action).toBe('update');
      expect(await stored('YC-6')).toMatchObject({ y_thaw: null, y_cut: 0.8, y_cook: 0.5 });
      await run([row({ yThaw: 0.6 })]);
      await run([row({ code: 'YC-NEW', yCut: 0.4 })]);
      expect(await stored('YC-6')).toMatchObject({ y_thaw: 0.6 });
      expect(await stored('YC-NEW')).toMatchObject({ y_thaw: null, y_cut: 0.4, y_cook: null });
      // the parser sends null for a 0 cell, never 0
      expect(itemImportIn.safeParse({ rows: [row({ yThaw: 0 })] }).success).toBe(false);
    }));

  it('exports carry the yields as percent, blank when none', () =>
    inRollback(c, async () => {
      await createIngredient(c, gm, makeScope([]), body('YC-7', { yThaw: 0.875, yCook: 0.5 }));
      const out = await buildExport(c, gm, 'ingredients', exportQuery.parse({}));
      const rows = out.rows as string[][];
      const i = rows[0]!.indexOf('Thawing %');
      expect(rows[0]!.slice(i)).toEqual(['Thawing %', 'Cutting / trimming %', 'Cooking %']);
      expect(rows.find((x) => x[0] === 'YC-7')!.slice(i)).toEqual(['87.5', '', '50']);
    }));

  it('backup round trip keeps non-null yields exactly; an old backup without the fields clears them on restore', () =>
    inRollback(c, async () => {
      await c.query(
        'UPDATE ingredient SET y_thaw = $1, y_cut = 0.8, y_cook = NULL WHERE code = (SELECT min(code) FROM ingredient)',
        [0.1 + 0.2],
      );
      const core = await buildBackupCore(c, gm);
      const first = core.ingredients[0]!;
      expect(first).toMatchObject({ yThaw: 0.1 + 0.2, yCut: 0.8, yCook: null });
      const parsed = backupSchema.parse(JSON.parse(JSON.stringify(core)));
      await c.query('UPDATE ingredient SET y_thaw = NULL, y_cut = NULL');
      await applyRestore(c, gm, parsed, 'yields.json');
      expect(await stored(first.code)).toMatchObject({ y_thaw: 0.1 + 0.2, y_cut: 0.8, y_cook: null });
      // a file from before this feature has no such fields: the restore clears the defaults
      const old = JSON.parse(JSON.stringify(core));
      for (const i of old.ingredients) {
        delete i.yThaw;
        delete i.yCut;
        delete i.yCook;
      }
      await applyRestore(c, gm, backupSchema.parse(old), 'old.json');
      expect(await stored(first.code)).toMatchObject({ y_thaw: null, y_cut: null, y_cook: null });
      expect(backupSchema.safeParse({ ...core, ingredients: [{ ...first, yThaw: 11 }] }).success).toBe(false);
    }));
});
