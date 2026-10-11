import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import { loadCatalog } from '@/lib/db/catalog';
import { visibleBrandIds } from '@/lib/db/scope';
import { ApiError } from '@/lib/errors';
import type { Role } from '@/lib/permissions';
import { buildCtx } from '@/lib/screens/ctx';
import { loadProd } from '@/lib/screens/prod';
import { applyRestore, backupSchema, buildBackupCore } from '@/lib/services/backup';
import { createClient, deleteClient, updateClient } from '@/lib/services/clients';
import { buildExport, exportQuery } from '@/lib/services/exports';
import { deleteBrand } from '@/lib/services/brands';
import { loadProduction, setProduction } from '@/lib/services/planning';
import { connect, expectFails, hasTestDb, inRollback, insertBrand, insertRecipe } from './helpers';

vi.mock('@/lib/db/catalog-cache', () => ({ getCatalog: vi.fn(), CATALOG_TAG: 'catalog' }));

async function fail(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected an ApiError');
}

describe.skipIf(!hasTestDb)('clients and the production key (D-68, D-71)', { timeout: 280_000 }, () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await connect();
  }, 60_000);
  afterAll(async () => {
    await c.end();
  });

  async function mkUser(role: Role, brandIds: string[] = []): Promise<SessionUser> {
    const { rows } = await c.query(`INSERT INTO app_user (clerk_user_id, name) VALUES ($1,$2) RETURNING id`, [
      `clerk-${role}-${Math.random()}`,
      `T ${role}`,
    ]);
    for (const b of brandIds)
      await c.query('INSERT INTO user_brand_access (user_id, brand_id) VALUES ($1,$2)', [rows[0]!.id, b]);
    return { id: rows[0]!.id as string, clerkUserId: 'c', email: null, name: `T ${role}`, role };
  }
  const scopeOf = (u: SessionUser) => visibleBrandIds(u, c);
  const prod = (month: string, day: string, loc: string, client: string, code: string, q: number) =>
    c.query(
      `INSERT INTO production_entry (month, day, location, client_id, recipe_code, portions) VALUES ($1,$2,$3,$4,$5,$6)`,
      [month, day, loc, client, code, q],
    );

  it('the production key includes the client: "" and a client coexist, a duplicate of either is refused, old 5-column inserts still work', () =>
    inRollback(c, async () => {
      const brand = await insertBrand(c, 'ZA');
      await insertRecipe(c, brand, 'ZA-1');
      const gm = await mkUser('gm');
      const id = await createClient(c, gm, await scopeOf(gm), brand, { name: 'Client A' });
      await c.query(
        `INSERT INTO production_entry (month, day, location, recipe_code, portions) VALUES ('2097-06','05','','ZA-1',4)`,
      ); // the old 5-column shape: client defaults to '' (unassigned)
      await prod('2097-06', '05', '', id, 'ZA-1', 7);
      const rows = (
        await c.query(`SELECT client_id, portions FROM production_entry WHERE recipe_code = 'ZA-1' ORDER BY portions`)
      ).rows;
      expect(rows.map((r) => [r.client_id, r.portions])).toEqual([
        ['', 4],
        [id, 7],
      ]);
      await expectFails(
        c,
        `INSERT INTO production_entry (month, day, location, recipe_code, portions) VALUES ('2097-06','05','','ZA-1',9)`,
        [],
        /duplicate key/,
      );
      await expectFails(
        c,
        `INSERT INTO production_entry (month, day, location, client_id, recipe_code, portions) VALUES ('2097-06','05','',$1,'ZA-1',9)`,
        [id],
        /duplicate key/,
      );
    }));

  it('only the General Manager and the Cost Controller manage clients; names are unique per brand (case-insensitive); a stale version is a 409', () =>
    inRollback(c, async () => {
      const a = await insertBrand(c, 'ZB');
      const b = await insertBrand(c, 'ZC');
      const gm = await mkUser('gm');
      const cc = await mkUser('cc', [a]);
      const gmScope = await scopeOf(gm);
      for (const role of ['chef', 'cook', 'fin', 'viewer'] as const) {
        const u = await mkUser(role, [a]);
        expect((await fail(createClient(c, u, await scopeOf(u), a, { name: 'X' }))).status).toBe(403);
      }
      const id = await createClient(c, cc, await scopeOf(cc), a, { name: 'Acme' });
      expect((await fail(createClient(c, gm, gmScope, a, { name: 'ACME' }))).status).toBe(409);
      await createClient(c, gm, gmScope, b, { name: 'Acme' }); // the same name in another brand is fine
      // a Cost Controller of brand A cannot see or touch brand B
      expect((await fail(createClient(c, cc, await scopeOf(cc), b, { name: 'Z' }))).status).toBe(404);
      await updateClient(c, cc, await scopeOf(cc), id, { name: 'Acme Ltd', version: 0 });
      expect((await fail(updateClient(c, cc, await scopeOf(cc), id, { active: false, version: 0 }))).status).toBe(409);
      await updateClient(c, cc, await scopeOf(cc), id, { active: false, version: 1 });
      const row = (await c.query('SELECT name, active, version FROM client WHERE id = $1', [id])).rows[0]!;
      expect(row).toMatchObject({ name: 'Acme Ltd', active: false, version: 2 });
      const audit = (await c.query(`SELECT action FROM audit_log WHERE action IN ('Added client','Edited client')`))
        .rows;
      expect(audit.length).toBeGreaterThanOrEqual(3);
    }));

  it('a client with production rows cannot be deleted, an unused one can; a brand with clients cannot be removed', () =>
    inRollback(c, async () => {
      const brand = await insertBrand(c, 'ZD');
      await insertRecipe(c, brand, 'ZD-1');
      const gm = await mkUser('gm');
      const s = await scopeOf(gm);
      const used = await createClient(c, gm, s, brand, { name: 'Used' });
      const free = await createClient(c, gm, s, brand, { name: 'Free' });
      await prod('2097-06', '05', '', used, 'ZD-1', 3);
      const e = await fail(deleteClient(c, gm, s, used));
      expect(e.status).toBe(409);
      await deleteClient(c, gm, s, free);
      expect((await c.query('SELECT 1 FROM client WHERE id = $1', [free])).rows).toHaveLength(0);
      await c.query('DELETE FROM recipe WHERE code = $1', ['ZD-1']);
      await c.query('DELETE FROM production_entry WHERE client_id = $1', [used]);
      expect((await fail(deleteBrand(c, gm, brand))).status).toBe(409); // "still has 1 client"
      await deleteClient(c, gm, s, used);
      await deleteBrand(c, gm, brand);
    }));

  it("setProduction writes one row per client, deleting one leaves the others, and the client must be active and of the card's brand", () =>
    inRollback(c, async () => {
      const a = await insertBrand(c, 'ZE');
      const b = await insertBrand(c, 'ZF');
      await insertRecipe(c, a, 'ZE-1');
      const gm = await mkUser('gm');
      const s = await scopeOf(gm);
      const c1 = await createClient(c, gm, s, a, { name: 'One' });
      const c2 = await createClient(c, gm, s, a, { name: 'Two' });
      const other = await createClient(c, gm, s, b, { name: 'Other brand' });
      const put = (clientId: string | undefined, portions: number) =>
        setProduction(c, gm, s, { month: '2097-06', day: '07', location: '', recipeCode: 'ZE-1', clientId, portions });
      await put(undefined, 5); // no client named = unassigned
      await put(c1, 10);
      await put(c2, 20);
      await put(c1, 11); // overwrites only c1's row
      const read = async () =>
        Object.fromEntries(
          (await loadProduction(c, s, '2097-06')).filter((r) => r.code === 'ZE-1').map((r) => [r.clientId, r.portions]),
        );
      expect(await read()).toEqual({ '': 5, [c1]: 11, [c2]: 20 });
      await put(c1, 0); // 0 deletes that client's row only
      expect(await read()).toEqual({ '': 5, [c2]: 20 });
      expect((await fail(put(other, 1))).status).toBe(422); // a client of another brand
      expect((await fail(put('no-such-client', 1))).status).toBe(404);
      await updateClient(c, gm, s, c2, { active: false, version: 0 });
      // an inactive client takes no NEW row ...
      const putOn = (day: string, portions: number) =>
        setProduction(c, gm, s, { month: '2097-06', day, location: '', recipeCode: 'ZE-1', clientId: c2, portions });
      expect((await fail(putOn('08', 1))).status).toBe(422);
      // ... but the rows it already has can still be corrected and cleared
      await putOn('07', 25);
      expect(await read()).toEqual({ '': 5, [c2]: 25 });
      await putOn('07', 0);
      expect(await read()).toEqual({ '': 5 });
      // a Cost Controller of another brand cannot name this brand's client at all
      const cc = await mkUser('cc', [b]);
      expect(
        (
          await fail(
            setProduction(c, cc, await scopeOf(cc), {
              month: '2097-06',
              day: '07',
              location: '',
              recipeCode: 'ZE-1',
              clientId: c1,
              portions: 1,
            }),
          )
        ).status,
      ).toBe(404);
    }));

  it('the Production screen reads one client, unassigned, or all added together; typing is locked under "all" only when the brand has clients', () =>
    inRollback(c, async () => {
      const a = await insertBrand(c, 'ZG');
      const b = await insertBrand(c, 'ZH');
      await insertRecipe(c, a, 'ZG-1');
      await insertRecipe(c, b, 'ZH-1');
      const gm = await mkUser('gm');
      const s = await scopeOf(gm);
      const c1 = await createClient(c, gm, s, a, { name: 'One' });
      await prod('2097-06', '09', '', '', 'ZG-1', 5);
      await prod('2097-06', '09', '', c1, 'ZG-1', 12);
      await prod('2097-06', '09', '', '', 'ZH-1', 3);
      const catalog = await loadCatalog(c);
      const ctx = await buildCtx(c, gm);
      const card = async (brand: string, client: string, code: string) => {
        const d = await loadProd(c, ctx, catalog, {
          view: 'day',
          month: '2097-06',
          day: '09',
          brand,
          loc: '*',
          client,
        });
        const r = d.sections.flatMap((x) => x.cards).find((x) => x.code === code);
        return { qty: r?.qty, locked: r?.locked, choices: d.clientChoices.map((x) => x.name), client: d.params.client };
      };
      expect(await card(a, '*', 'ZG-1')).toEqual({ qty: 17, locked: true, choices: ['One'], client: '*' });
      expect(await card(a, 'none', 'ZG-1')).toMatchObject({ qty: 5, locked: false });
      expect(await card(a, c1, 'ZG-1')).toMatchObject({ qty: 12, locked: false });
      // a brand without clients behaves exactly as before: no choices, never locked
      expect(await card(b, '*', 'ZH-1')).toEqual({ qty: 3, locked: false, choices: [], client: '*' });
      // under All brands the client is ignored (a client belongs to one brand); the brand with clients is still locked
      expect(await card('*', c1, 'ZG-1')).toMatchObject({ qty: 17, locked: true, client: '*' });
      expect(await card('*', '*', 'ZH-1')).toMatchObject({ qty: 3, locked: false });
      // a client id of the wrong brand falls back to all
      expect((await card(b, c1, 'ZH-1')).client).toBe('*');
    }));

  it('the production export follows the Client choice: one client, unassigned or all; a client the caller cannot see is a 404', () =>
    inRollback(c, async () => {
      const a = await insertBrand(c, 'ZJ');
      const other = await insertBrand(c, 'ZK');
      await insertRecipe(c, a, 'ZJ-1');
      const gm = await mkUser('gm');
      const s = await scopeOf(gm);
      const c1 = await createClient(c, gm, s, a, { name: 'One' });
      await prod('2097-06', '12', '', '', 'ZJ-1', 5);
      await prod('2097-06', '12', '', c1, 'ZJ-1', 12);
      const portions = async (client: string) => {
        const f = await buildExport(c, gm, 'production', exportQuery.parse({ month: '2097-06', client }));
        const row = f.rows.find((r) => r[6] === 'ZJ-1');
        return row ? Number(row[7]) : 0;
      };
      expect(await portions('*')).toBe(17);
      expect(await portions('none')).toBe(5);
      expect(await portions(c1)).toBe(12);
      const cc = await mkUser('cc', [other]);
      expect(
        (await fail(buildExport(c, cc, 'production', exportQuery.parse({ month: '2097-06', client: c1 })))).status,
      ).toBe(404);
    }));

  it("backup round trip keeps clients and each row's client; a file from before clients restores everything as unassigned", () =>
    inRollback(c, async () => {
      const brand = await insertBrand(c, 'ZI');
      await insertRecipe(c, brand, 'ZI-1');
      const gm = await mkUser('gm');
      const s = await scopeOf(gm);
      const id = await createClient(c, gm, s, brand, { name: 'Kept' });
      await prod('2097-06', '11', '', '', 'ZI-1', 2);
      await prod('2097-06', '11', '', id, 'ZI-1', 8);

      const core = await buildBackupCore(c, gm);
      expect(core.clients?.find((x) => x.name === 'Kept')).toMatchObject({ brandCode: 'ZI', active: true });
      expect(
        core.production
          .filter((p) => p.recipeCode === 'ZI-1')
          .map((p) => [p.clientId === id ? 'client' : p.clientId, p.portions]),
      ).toEqual([
        ['', 2],
        ['client', 8],
      ]);
      // keep the file small (the restore soft-deletes the other cards inside the rolled-back transaction)
      const slim = {
        ...core,
        ingredients: core.ingredients.slice(0, 3),
        recipes: core.recipes.filter((r) => r.code === 'ZI-1'),
        menus: [],
        menuPax: [],
        production: core.production.filter((p) => p.recipeCode === 'ZI-1'),
      };
      const text = JSON.stringify(slim);
      expect(backupSchema.safeParse(JSON.parse(text)).success).toBe(true);

      // a file whose clients repeat a name (any case) or name an unknown brand is refused before anything is written
      const dup = {
        ...JSON.parse(text),
        clients: [...slim.clients!, { ...slim.clients![0]!, id: 'x', name: slim.clients![0]!.name.toUpperCase() }],
      };
      expect((await fail(applyRestore(c, gm, backupSchema.parse(dup), 'dup.json'))).status).toBe(422);
      const orphan = { ...JSON.parse(text), clients: [{ id: 'y', brandCode: 'NOPE', name: 'Lost', active: true }] };
      expect((await fail(applyRestore(c, gm, backupSchema.parse(orphan), 'orphan.json'))).status).toBe(422);

      // restoring the same file changes nothing (clients matched by brand + name, the row's client id translated)
      await applyRestore(c, gm, backupSchema.parse(JSON.parse(text)), 'self.json');
      const after = (
        await c.query(`SELECT client_id, portions FROM production_entry WHERE recipe_code = 'ZI-1' ORDER BY portions`)
      ).rows;
      expect(after.map((r) => [r.client_id === id ? 'client' : r.client_id, r.portions])).toEqual([
        ['', 2],
        ['client', 8],
      ]);
      expect(Number((await c.query(`SELECT count(*) AS n FROM client WHERE brand_id = $1`, [brand])).rows[0]!.n)).toBe(
        1,
      );

      // a file from before clients existed: no `clients`, no `clientId` on any row
      const old = JSON.parse(text) as Record<string, unknown> & { production: Record<string, unknown>[] };
      delete old.clients;
      for (const p of old.production) delete p.clientId;
      const parsed = backupSchema.parse(old);
      expect(parsed.production.every((p) => p.clientId === '')).toBe(true);
      await applyRestore(c, gm, parsed, 'old.json');
      const unassigned = (await c.query(`SELECT client_id, portions FROM production_entry WHERE recipe_code = 'ZI-1'`))
        .rows;
      expect(unassigned.map((r) => r.client_id)).toEqual(['']); // the two rows now share the key: one survives
      expect(Number((await c.query(`SELECT count(*) AS n FROM client WHERE brand_id = $1`, [brand])).rows[0]!.n)).toBe(
        1,
      ); // clients left alone
    }));
});
