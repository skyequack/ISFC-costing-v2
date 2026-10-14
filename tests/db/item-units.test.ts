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
import { createIngredient, updateIngredient } from '@/lib/services/ingredients';
import { addUnit, deleteUnit, listUnits } from '@/lib/services/units';
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

describe.skipIf(!hasTestDb)('three units per raw material (D-102, D-103)', { timeout: 280_000 }, () => {
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
    c
      .query(
        'SELECT purchase_unit, purchase_factor, inventory_unit, inventory_factor, version FROM ingredient WHERE code = $1',
        [code],
      )
      .then((r) => r.rows[0]!);
  const idOf = (code: string) =>
    c.query('SELECT id FROM ingredient WHERE code = $1', [code]).then((r) => r.rows[0]!.id as string);
  const lastAudit = (action: string) =>
    c
      .query(`SELECT detail FROM audit_log WHERE action = $1 ORDER BY created_at DESC LIMIT 1`, [action])
      .then((r) => r.rows[0]?.detail as string | undefined);

  it('migration 0013 backfilled every item with its base unit and factor 1, and left price and flag alone', async () => {
    const r = await c.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE purchase_unit = uom AND purchase_factor = 1 AND inventory_unit = uom AND inventory_factor = 1)::int AS ok
         FROM ingredient`,
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
    expect(r.rows[0].ok).toBe(r.rows[0].n);
  });

  it('seeds the unit list', async () => {
    const codes = (await listUnits(c)).map((u) => u.code);
    expect(codes).toEqual(['Gram', 'Kg', 'Ml', 'L', 'Each', 'Slice', 'Carton', 'Box', 'Bag', 'Tray', 'Pack']);
  });

  it('the CHECKs refuse a factor of 0, a negative one, a lone unit and an unknown unit', () =>
    inRollback(c, async () => {
      const ins = (cols: string, vals: string) =>
        `INSERT INTO ingredient (code, name, uom, price, category, subcategory, flag, ${cols}) VALUES ('UN-X','x','Gram',1,'c','s','',${vals})`;
      await expectFails(c, ins('purchase_unit, purchase_factor', `'Carton', 0`), [], /ingredient_units_factor/);
      await expectFails(c, ins('purchase_unit, purchase_factor', `'Carton', -2`), [], /ingredient_units_factor/);
      await expectFails(c, ins('inventory_unit', `'Carton'`), [], /ingredient_units_pair/);
      await expectFails(c, ins('purchase_unit, purchase_factor', `'Crate', 5`), [], /foreign key/);
    }));

  it('a new item defaults to its base unit; units are stored and read back exactly', () =>
    inRollback(c, async () => {
      const scope = makeScope([]);
      await createIngredient(c, gm, scope, body('UN-1'));
      expect(await stored('UN-1')).toMatchObject({
        purchase_unit: 'Gram',
        purchase_factor: 1,
        inventory_unit: 'Gram',
        inventory_factor: 1,
      });
      await createIngredient(
        c,
        gm,
        scope,
        body('UN-2', { purchaseUnit: 'Carton', purchaseFactor: 0.1 + 0.2, inventoryUnit: 'kg' }),
      );
      expect(await stored('UN-2')).toMatchObject({
        purchase_unit: 'Carton',
        purchase_factor: 0.1 + 0.2,
        inventory_unit: 'Kg',
        inventory_factor: 1000,
      });
      const it = (await listIngredients(c, scope, true)).find((i) => i.code === 'UN-2')!;
      expect(it).toMatchObject({ purchaseUnit: 'Carton', inventoryUnit: 'Kg', inventoryFactor: 1000 });
      expect((await listIngredients(c, scope)).find((i) => i.code === 'UN-2')).not.toHaveProperty('purchaseUnit');
    }));

  it('refuses a mixed unit, an unknown unit and a pack unit with no usable factor', () =>
    inRollback(c, async () => {
      const scope = makeScope([]);
      expect((await fail(createIngredient(c, gm, scope, body('UN-3', { purchaseUnit: 'L' })))).status).toBe(422);
      expect((await fail(createIngredient(c, gm, scope, body('UN-3', { inventoryUnit: 'Crate' })))).status).toBe(400);
      expect((await fail(createIngredient(c, gm, scope, body('UN-3', { purchaseUnit: 'Bag' })))).status).toBe(422);
      expect(
        (await fail(createIngredient(c, gm, scope, body('UN-3', { purchaseUnit: 'Bag', purchaseFactor: 1e-9 }))))
          .status,
      ).toBe(422);
      expect(() => body('UN-3', { purchaseUnit: 'Bag', purchaseFactor: NaN })).toThrow();
      expect((await c.query(`SELECT 1 FROM ingredient WHERE code = 'UN-3'`)).rowCount).toBe(0);
    }));

  it('update: absent keeps, a change is audited and bumps the version, an unchanged save is a plain edit', () =>
    inRollback(c, async () => {
      const scope = makeScope([]);
      await createIngredient(c, gm, scope, body('UN-4', { purchaseUnit: 'Carton', purchaseFactor: 12000 }));
      const id = await idOf('UN-4');
      let v = (await stored('UN-4')).version as number;
      // a price-only edit (units absent) must keep them
      await updateIngredient(c, gm, scope, id, { ...body('UN-4', { price: 3 }), version: v });
      expect(await stored('UN-4')).toMatchObject({ purchase_unit: 'Carton', purchase_factor: 12000 });
      expect(await lastAudit('Changed item units')).toBeUndefined();
      v++;
      await updateIngredient(c, gm, scope, id, {
        ...body('UN-4', { price: 3, purchaseUnit: 'Carton', purchaseFactor: 10000, inventoryUnit: 'Kg' }),
        version: v,
      });
      expect(await stored('UN-4')).toMatchObject({
        purchase_factor: 10000,
        inventory_unit: 'Kg',
        inventory_factor: 1000,
        version: v + 1,
      });
      expect(await lastAudit('Changed item units')).toBe(
        'UN-4: purchase 1 Carton = 12000 Gram · inventory Gram (base) → purchase 1 Carton = 10000 Gram · inventory 1 Kg = 1000 Gram',
      );
    }));

  it('changing the base unit: a unit that was the base follows it, anything else must be chosen again', () =>
    inRollback(c, async () => {
      const scope = makeScope([]);
      await createIngredient(c, gm, scope, body('UN-5'));
      const id = await idOf('UN-5');
      await updateIngredient(c, gm, scope, id, { ...body('UN-5', { uom: 'Ml' }), version: 0 });
      expect(await stored('UN-5')).toMatchObject({ purchase_unit: 'Ml', inventory_unit: 'Ml' });
      await createIngredient(c, gm, scope, body('UN-6', { purchaseUnit: 'Kg' }));
      const id6 = await idOf('UN-6');
      const err = await fail(updateIngredient(c, gm, scope, id6, { ...body('UN-6', { uom: 'Ml' }), version: 0 }));
      expect(err.status).toBe(422);
      await updateIngredient(c, gm, scope, id6, {
        ...body('UN-6', { uom: 'Ml', purchaseUnit: 'L' }),
        version: 0,
      });
      expect(await stored('UN-6')).toMatchObject({ purchase_unit: 'L', purchase_factor: 1000, inventory_unit: 'Ml' });
    }));

  it('only the GM adds or deletes units; a used unit cannot go; the base units are fixed', () =>
    inRollback(c, async () => {
      expect((await fail(addUnit(c, U('cc'), 'Drum'))).status).toBe(403);
      expect((await fail(deleteUnit(c, U('fin'), 'Carton'))).status).toBe(403);
      await addUnit(c, gm, 'Drum');
      expect((await fail(addUnit(c, gm, 'drum'))).status).toBe(409);
      expect((await fail(addUnit(c, gm, 'bad;name'))).status).toBe(400);
      expect((await fail(addUnit(c, gm, `=1+1`))).status).toBe(400);
      expect((await listUnits(c)).find((u) => u.code === 'Drum')).toMatchObject({
        kind: 'pack',
        toBase: null,
        used: 0,
      });
      await createIngredient(c, gm, makeScope([]), body('UN-7', { purchaseUnit: 'Drum', purchaseFactor: 18000 }));
      expect((await listUnits(c)).find((u) => u.code === 'Drum')!.used).toBe(1);
      expect((await fail(deleteUnit(c, gm, 'Drum'))).status).toBe(409);
      expect((await fail(deleteUnit(c, gm, 'Kg'))).status).toBe(422);
      expect((await fail(deleteUnit(c, gm, 'Nope'))).status).toBe(404);
      await c.query(`UPDATE ingredient SET purchase_unit = 'Gram', purchase_factor = 1 WHERE code = 'UN-7'`);
      await deleteUnit(c, gm, 'Drum');
      expect((await listUnits(c)).some((u) => u.code === 'Drum')).toBe(false);
      expect(await lastAudit('Deleted unit')).toBe('Drum');
    }));

  it('a user cannot set units on an item scoped to brands they cannot see', () =>
    inRollback(c, async () => {
      const b1 = await insertBrand(c, 'UNB');
      await createIngredient(c, gm, makeScope([b1]), body('UN-8', { brandIds: [b1] }));
      const id = await idOf('UN-8');
      const err = await fail(
        updateIngredient(c, U('cc'), makeScope([]), id, { ...body('UN-8', { purchaseUnit: 'Kg' }), version: 0 }),
      );
      expect(err.status).toBe(404);
    }));

  it('price-list import: blank leaves the units, a pack unit with a quantity sets them, a bad unit blocks the row', () =>
    inRollback(c, async () => {
      const scope = makeScope([]);
      await createIngredient(c, gm, scope, body('UN-9', { purchaseUnit: 'Carton', purchaseFactor: 12000 }));
      const row = (extra: Record<string, unknown>) => ({
        code: 'UN-9',
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
        if (!plan.counts.blocked) await commitItemImport(c, gm, scope, { ...input, hash: plan.hash });
        return plan;
      };
      expect((await run([row({})])).rows[0]!.action).toBe('same');
      expect(await stored('UN-9')).toMatchObject({ purchase_unit: 'Carton', purchase_factor: 12000 });
      expect((await run([row({ inventoryUnit: 'Kg' })])).rows[0]!.action).toBe('update');
      expect(await stored('UN-9')).toMatchObject({ inventory_unit: 'Kg', inventory_factor: 1000 });
      await run([row({ code: 'UN-NEW', purchaseUnit: 'bag', purchaseFactor: 25000 })]);
      expect(await stored('UN-NEW')).toMatchObject({
        purchase_unit: 'Bag',
        purchase_factor: 25000,
        inventory_unit: 'Gram',
      });
      // never creates a unit, never mixes dimensions, a pack unit needs its quantity
      const unknown = await run([row({ purchaseUnit: 'Crate', purchaseFactor: 5 })]);
      expect(unknown.rows[0]).toMatchObject({ action: 'blocked', reason: 'Crate is not in the unit list' });
      expect((await run([row({ purchaseUnit: 'L' })])).rows[0]!.reason).toMatch(/cannot be used/);
      expect((await run([row({ inventoryUnit: 'Box' })])).rows[0]!.reason).toMatch(/Enter how many/);
      expect((await c.query(`SELECT 1 FROM unit WHERE lower(code) = 'crate'`)).rowCount).toBe(0);
      expect((await stored('UN-9')).purchase_factor).toBe(12000);
    }));

  it('exports carry the four unit columns', () =>
    inRollback(c, async () => {
      await createIngredient(
        c,
        gm,
        makeScope([]),
        body('UN-10', { purchaseUnit: 'Carton', purchaseFactor: 12000, inventoryUnit: 'Kg' }),
      );
      for (const kind of ['ingredients', 'price-template'] as const) {
        const rows = (await buildExport(c, gm, kind, exportQuery.parse({}))).rows as string[][];
        const i = rows[0]!.indexOf('Buying Unit');
        expect(rows[0]!.slice(i)).toEqual(['Buying Unit', 'Buying Qty', 'Counting Unit', 'Counting Qty']);
        expect(rows.find((x) => x[0] === 'UN-10')!.slice(i)).toEqual(['Carton', '12000', 'Kg', '1000']);
      }
    }));

  it('backup round trip keeps the units and the units the GM added; an older file restores with the base unit and 1', () =>
    inRollback(c, async () => {
      await addUnit(c, gm, 'Drum');
      await createIngredient(
        c,
        gm,
        makeScope([]),
        body('UN-11', { purchaseUnit: 'Drum', purchaseFactor: 0.1 + 0.2, inventoryUnit: 'Kg' }),
      );
      const core = await buildBackupCore(c, gm);
      expect(core.units?.map((u) => u.code)).toContain('Drum');
      const item = core.ingredients.find((i) => i.code === 'UN-11')!;
      expect(item).toMatchObject({
        purchaseUnit: 'Drum',
        purchaseFactor: 0.1 + 0.2,
        inventoryUnit: 'Kg',
        inventoryFactor: 1000,
      });
      const parsed = backupSchema.parse(JSON.parse(JSON.stringify(core)));
      await c.query(`UPDATE ingredient SET purchase_unit = 'Gram', purchase_factor = 1 WHERE code = 'UN-11'`);
      await c.query(`DELETE FROM unit WHERE code = 'Drum'`);
      await applyRestore(c, gm, parsed, 'units.json');
      expect(await stored('UN-11')).toMatchObject({
        purchase_unit: 'Drum',
        purchase_factor: 0.1 + 0.2,
        inventory_unit: 'Kg',
      });
      // a file from before this feature: no unit fields at all
      const old = JSON.parse(JSON.stringify(core));
      delete old.units;
      for (const i of old.ingredients) {
        delete i.purchaseUnit;
        delete i.purchaseFactor;
        delete i.inventoryUnit;
        delete i.inventoryFactor;
      }
      await applyRestore(c, gm, backupSchema.parse(old), 'old.json');
      expect(await stored('UN-11')).toMatchObject({
        purchase_unit: 'Gram',
        purchase_factor: 1,
        inventory_unit: 'Gram',
        inventory_factor: 1,
      });
      // a unit that does not fit the item's base unit fails the whole restore
      const bad = JSON.parse(JSON.stringify(core));
      bad.ingredients.find((i: { code: string }) => i.code === 'UN-11').purchaseUnit = 'L';
      expect((await fail(applyRestore(c, gm, backupSchema.parse(bad), 'bad.json'))).status).toBe(422);
    }));
});
