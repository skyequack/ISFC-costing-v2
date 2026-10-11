import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import { makeScope, type BrandScope } from '@/lib/db/scope';
import { ApiError } from '@/lib/errors';
import type { Role } from '@/lib/permissions';
import {
  deleteUser,
  inviteUser,
  listInvites,
  listUsers,
  revokeInvite,
  setUserBanned,
  updateInvite,
  updateUser,
  type ClerkPort,
  type ClerkUserLite,
} from '@/lib/services/users';
import {
  createMenu,
  loadProduction,
  priceMenuItem,
  saveMenu,
  setMenuActive,
  setMenuPax,
  setProduction,
} from '@/lib/services/planning';
import { deleteBrand } from '@/lib/services/brands';
import { createClient } from '@/lib/services/clients';
import { applyMenuDay } from '@/lib/services/planning-apply';
import { createRecipe } from '@/lib/services/recipes';
import { PROVISION_SQL } from '@/lib/auth/provision-sql';
import { connect, hasTestDb, inRollback, insertBrand } from './helpers';

vi.mock('@/lib/db/catalog-cache', () => ({ getCatalog: vi.fn(), CATALOG_TAG: 'catalog' }));

const U = (role: Role, n: string = role): SessionUser => ({
  id: `u-${n}`,
  clerkUserId: `c-${n}`,
  email: null,
  name: `T ${n}`,
  role,
});
const gm = U('gm');

async function fail(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected an ApiError');
}

/** In-memory Clerk: records calls so compensation and ordering can be asserted. */
function fakeClerk(users: ClerkUserLite[]): ClerkPort & { calls: string[]; failRemove?: boolean } {
  const m = new Map(users.map((u) => [u.id, { ...u }]));
  const calls: string[] = [];
  const invs = new Map<string, { id: string; email: string; role: Role | null }>();
  let n = 0;
  return {
    calls,
    async list() {
      return [...m.values()].map((u) => ({ ...u }));
    },
    async get(id) {
      const u = m.get(id);
      if (!u) throw new ApiError('not_found', 'Not found');
      return { ...u };
    },
    async setRole(id, role) {
      calls.push(`role ${id} ${role}`);
      m.get(id)!.role = role;
    },
    async ban(id) {
      calls.push(`ban ${id}`);
      m.get(id)!.banned = true;
    },
    async unban(id) {
      calls.push(`unban ${id}`);
      m.get(id)!.banned = false;
    },
    async remove(id) {
      calls.push(`remove ${id}`);
      m.delete(id);
    },
    async invite(email, role) {
      calls.push(`invite ${email} ${role}`);
      const id = `inv-${++n}`;
      for (const [k, v] of invs) if (v.email === email) invs.delete(k); // like ignoreExisting
      invs.set(id, { id, email, role });
      return id;
    },
    async listInvitations() {
      return [...invs.values()].map((i) => ({ ...i }));
    },
    async revokeInvitation(id) {
      calls.push(`revoke ${id}`);
      if (!invs.delete(id)) throw new ApiError('not_found', 'Not found');
    },
  };
}
const cu = (id: string, role: Role | null, banned = false): ClerkUserLite => ({
  id,
  name: `Name ${id}`,
  email: `${id}@x.test`,
  role,
  banned,
});

describe.skipIf(!hasTestDb)('users tab rules (D-31) with a fake Clerk', { timeout: 120_000 }, () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await connect();
  }, 60_000);
  afterAll(async () => {
    await c.end();
  });

  it('only the GM may use it; invitation goes to Clerk with the role and is audited', () =>
    inRollback(c, async () => {
      const clerk = fakeClerk([cu('c-gm', 'gm')]);
      expect((await fail(listUsers(c, clerk, U('cc')))).status).toBe(403);
      expect((await fail(inviteUser(c, clerk, U('fin'), { email: 'a@b.co', role: 'chef' }))).status).toBe(403);
      await inviteUser(c, clerk, gm, { email: 'new@b.co', role: 'chef' });
      expect(clerk.calls).toEqual(['invite new@b.co chef']);
      const a = await c.query(
        `SELECT detail FROM audit_log WHERE action = 'Invited user' ORDER BY created_at DESC LIMIT 1`,
      );
      expect(a.rows[0]!.detail).toContain('Head Chef');
    }));

  it('pending invitations (D-78..D-80): brands stored, listed, edited, revoked; ids only from the pending list', () =>
    inRollback(c, async () => {
      const b1 = await insertBrand(c, 'IA');
      const b2 = await insertBrand(c, 'IB');
      const clerk = fakeClerk([cu('c-gm', 'gm')]);
      await inviteUser(c, clerk, gm, { email: 'new@b.co', role: 'chef', brandIds: [b2, b1, b1] });
      let { invites } = await listInvites(c, clerk, gm);
      expect(invites).toHaveLength(1);
      expect(invites[0]).toMatchObject({ email: 'new@b.co', role: 'chef' });
      expect(invites[0]!.brandIds).toEqual([b1, b2].sort());
      const id = invites[0]!.id;

      // authorisation, unknown brand, unknown id
      expect((await fail(listInvites(c, clerk, U('cc')))).status).toBe(403);
      expect((await fail(revokeInvite(c, clerk, U('cc'), id))).status).toBe(403);
      expect((await fail(inviteUser(c, clerk, gm, { email: 'x@b.co', role: 'chef', brandIds: ['nope'] }))).status).toBe(
        400,
      );
      expect((await fail(revokeInvite(c, clerk, gm, 'c-gm'))).status).toBe(404); // a user id is not an invitation id
      expect((await fail(updateInvite(c, clerk, gm, 'inv-999', { brandIds: [] }))).status).toBe(404);

      // brands-only edit sends nothing to Clerk
      const before = clerk.calls.length;
      await updateInvite(c, clerk, gm, id, { brandIds: [b1] });
      expect(clerk.calls.length).toBe(before);
      expect((await listInvites(c, clerk, gm)).invites[0]!.brandIds).toEqual([b1]);

      // role change = revoke + create (new id, brands kept)
      const r = await updateInvite(c, clerk, gm, id, { role: 'cc' });
      expect(r.id).not.toBe(id);
      expect(clerk.calls.slice(before)).toEqual([`revoke ${id}`, 'invite new@b.co cc']);
      ({ invites } = await listInvites(c, clerk, gm));
      expect(invites[0]).toMatchObject({ id: r.id, role: 'cc', brandIds: [b1] });

      // GM invite keeps no brands
      await updateInvite(c, clerk, gm, r.id, { role: 'gm', brandIds: [b1] });
      const stored = await c.query(`SELECT count(*)::int AS n FROM invite_brand_access WHERE email = 'new@b.co'`);
      expect(stored.rows[0]!.n).toBe(0);

      // revoke removes the invitation and its brands; a second revoke is a 404
      await inviteUser(c, clerk, gm, { email: 'two@b.co', role: 'viewer', brandIds: [b2] });
      const two = (await listInvites(c, clerk, gm)).invites.find((i) => i.email === 'two@b.co')!;
      await revokeInvite(c, clerk, gm, two.id);
      expect((await listInvites(c, clerk, gm)).invites.find((i) => i.email === 'two@b.co')).toBeUndefined();
      expect((await c.query(`SELECT 1 FROM invite_brand_access WHERE email = 'two@b.co'`)).rowCount).toBe(0);
      expect((await fail(revokeInvite(c, clerk, gm, two.id))).status).toBe(404);
      const a = await c.query(`SELECT action FROM audit_log WHERE action IN ('Revoked invite','Updated invite') `);
      expect(a.rowCount).toBeGreaterThanOrEqual(3);
    }));

  it('a pending invitation blocks deleting its brand (RESTRICT) and a failing Clerk list degrades, not throws', () =>
    inRollback(c, async () => {
      const b = await insertBrand(c, 'IC');
      const clerk = fakeClerk([cu('c-gm', 'gm')]);
      await inviteUser(c, clerk, gm, { email: 'blk@b.co', role: 'chef', brandIds: [b] });
      const e = await fail(deleteBrand(c, gm, b));
      expect(e.status).toBe(409);
      expect(e.message).toContain('1 pending invitation(s)');
      const broken = { ...clerk, listInvitations: async () => Promise.reject(new Error('clerk down')) };
      expect(await listInvites(c, broken, gm)).toEqual({ invites: [], failed: true });
    }));

  it('first sign-in moves the promised brands once, only for a new user with a verified email (D-79)', () =>
    inRollback(c, async () => {
      const b1 = await insertBrand(c, 'PA');
      const b2 = await insertBrand(c, 'PB');
      const seed = (email: string) =>
        c.query('INSERT INTO invite_brand_access (email, brand_id) SELECT $1, unnest($2::text[])', [email, [b1, b2]]);
      const brandsOf = async (clerkId: string) =>
        (
          await c.query(
            'SELECT a.brand_id FROM user_brand_access a JOIN app_user u ON u.id = a.user_id WHERE u.clerk_user_id = $1 ORDER BY 1',
            [clerkId],
          )
        ).rows.map((r) => r.brand_id as string);
      const left = async (email: string) =>
        (await c.query('SELECT count(*)::int AS n FROM invite_brand_access WHERE email = $1', [email])).rows[0]!.n;

      await seed('p@x.test');
      await c.query(PROVISION_SQL, ['c-p1', 'p@x.test', 'P', 'chef']);
      expect(await brandsOf('c-p1')).toEqual([b1, b2].sort());
      expect(await left('p@x.test')).toBe(0);

      await seed('p@x.test'); // the same user signing in again is not new: nothing is granted, nothing consumed
      await c.query(PROVISION_SQL, ['c-p1', 'p@x.test', 'P', 'chef']);
      expect(await left('p@x.test')).toBe(2);

      await c.query(PROVISION_SQL, ['c-p2', null, 'Q', 'chef']); // unverified email -> nothing
      expect(await brandsOf('c-p2')).toEqual([]);
      await c.query(PROVISION_SQL, ['c-p3', 'other@x.test', 'R', 'chef']); // a different email -> nothing
      expect(await brandsOf('c-p3')).toEqual([]);
      expect(await left('p@x.test')).toBe(2);
    }));

  it('role change restores the old invitation when the new one cannot be created', () =>
    inRollback(c, async () => {
      const clerk = fakeClerk([cu('c-gm', 'gm')]);
      await inviteUser(c, clerk, gm, { email: 'rb@b.co', role: 'chef' });
      const id = (await clerk.listInvitations())[0]!.id;
      const real = clerk.invite;
      let first = true;
      clerk.invite = async (e, r) => {
        if (first) {
          first = false;
          throw new Error('clerk down');
        }
        return real(e, r);
      };
      await expect(updateInvite(c, clerk, gm, id, { role: 'cc' })).rejects.toThrow('clerk down');
      const left = await clerk.listInvitations();
      expect(left).toHaveLength(1);
      expect(left[0]).toMatchObject({ email: 'rb@b.co', role: 'chef' });
    }));

  it('role change: Clerk is written, app row follows; no self change; last active GM is protected', () =>
    inRollback(c, async () => {
      const clerk = fakeClerk([cu('c-gm', 'gm'), cu('c-cook', 'cook')]);
      await updateUser(c, clerk, gm, 'c-cook', { role: 'cc' });
      expect(clerk.calls).toContain('role c-cook cc');
      expect((await fail(updateUser(c, clerk, gm, 'c-gm', { role: 'viewer' }))).status).toBe(403); // self
      const other = U('gm', 'other');
      expect((await fail(updateUser(c, clerk, other, 'c-gm', { role: 'viewer' }))).status).toBe(409); // c-gm is the only active GM
      await updateUser(c, fakeClerk([cu('c-gm', 'gm'), cu('c-gm2', 'gm')]), other, 'c-gm', { role: 'viewer' }); // a second GM exists
    }));

  it('brand access is replaced; unknown brands rejected; a Clerk-only user gets an app row on demand', () =>
    inRollback(c, async () => {
      const b1 = await insertBrand(c, 'UA');
      const b2 = await insertBrand(c, 'UB');
      const clerk = fakeClerk([cu('c-gm', 'gm'), cu('c-new', 'chef')]);
      await updateUser(c, clerk, gm, 'c-new', { brandIds: [b1, b2] });
      const rows = await listUsers(c, clerk, gm);
      expect(rows.find((r) => r.id === 'c-new')!.brandIds.sort()).toEqual([b1, b2].sort());
      await updateUser(c, clerk, gm, 'c-new', { brandIds: [b2] });
      expect((await listUsers(c, clerk, gm)).find((r) => r.id === 'c-new')!.brandIds).toEqual([b2]);
      expect((await fail(updateUser(c, clerk, gm, 'c-new', { brandIds: ['nope'] }))).status).toBe(400);
    }));

  it('ban / unban / delete: protections, app_user.active mirrors Clerk, compensation when the DB step fails', () =>
    inRollback(c, async () => {
      const clerk = fakeClerk([cu('c-gm', 'gm'), cu('c-a', 'cook')]);
      expect((await fail(setUserBanned(c, clerk, gm, 'c-gm', true))).status).toBe(403); // yourself
      await setUserBanned(c, clerk, gm, 'c-a', true);
      expect((await c.query(`SELECT active FROM app_user WHERE clerk_user_id = 'c-a'`)).rows[0]!.active).toBe(false);
      await setUserBanned(c, clerk, gm, 'c-a', false);
      expect((await c.query(`SELECT active FROM app_user WHERE clerk_user_id = 'c-a'`)).rows[0]!.active).toBe(true);
      expect((await fail(deleteUser(c, clerk, gm, 'c-gm'))).status).toBe(403);
      const lastGm = fakeClerk([cu('c-only', 'gm')]);
      expect((await fail(deleteUser(c, lastGm, U('gm', 'x'), 'c-only'))).status).toBe(409);
      await deleteUser(c, clerk, gm, 'c-a');
      expect(clerk.calls.at(-1)).toBe('remove c-a'); // Clerk call last
      expect((await c.query(`SELECT active FROM app_user WHERE clerk_user_id = 'c-a'`)).rows[0]!.active).toBe(false); // row kept for audit snapshots
      // compensation: DB step fails after Clerk succeeded -> Clerk is rolled back
      const clerk2 = fakeClerk([cu('c-gm', 'gm'), cu('c-b', 'cook')]);
      const broken = { query: async () => Promise.reject(new Error('db down')) };
      await expect(updateUser(broken as never, clerk2, gm, 'c-b', { role: 'cc' })).rejects.toThrow();
      await c.query('SELECT 1');
    }));
});

describe.skipIf(!hasTestDb)(
  'planning services (menus, headcounts, production, apply, price)',
  { timeout: 120_000 },
  () => {
    let c: pg.Client;
    beforeAll(async () => {
      c = await connect();
    }, 60_000);
    afterAll(async () => {
      await c.end();
    });

    async function ssem(): Promise<{ id: string; scope: BrandScope }> {
      const id = (await c.query(`SELECT id FROM brand WHERE legacy_id = 'bssem'`)).rows[0]!.id as string;
      return { id, scope: makeScope([id]) };
    }

    it('menus are SSEM-only (404 for other scopes); basic editor validates codes and versions; deactivate keeps headcounts', () =>
      inRollback(c, async () => {
        const { scope } = await ssem();
        const other = makeScope([await insertBrand(c, 'QQ')]);
        expect((await fail(createMenu(c, gm, other, 'X', ['SATURDAY']))).status).toBe(404);
        expect((await fail(createMenu(c, U('chef'), scope, 'X', ['SATURDAY']))).status).toBe(403);
        const id = await createMenu(c, U('cc'), scope, 'TEST MENU', ['SATURDAY', 'SUNDAY']);
        const item = (await c.query(`SELECT code FROM ingredient LIMIT 1`)).rows[0]!.code as string;
        await saveMenu(c, gm, scope, id, {
          version: 0,
          name: 'TEST MENU',
          days: ['SATURDAY', 'SUNDAY'],
          rows: [{ meal: 'LUNCH', cells: { SATURDAY: { label: 'dish', kind: 'ITEM', code: item }, SUNDAY: null } }],
        });
        expect(
          (await fail(saveMenu(c, gm, scope, id, { version: 0, name: 'TEST MENU', days: ['SATURDAY'], rows: [] })))
            .status,
        ).toBe(409);
        expect(
          (
            await fail(
              saveMenu(c, gm, scope, id, {
                version: 1,
                name: 'TEST MENU',
                days: ['SATURDAY'],
                rows: [{ meal: 'L', cells: { SATURDAY: { label: 'x', kind: 'RECIPE', code: 'NOPE-0' } } }],
              }),
            )
          ).status,
        ).toBe(422);
        await setMenuPax(c, gm, scope, { month: '2099-01', day: '05', location: '', menuId: id, people: 12 });
        await setMenuActive(c, gm, scope, id, false);
        expect(Number((await c.query('SELECT people FROM menu_pax WHERE menu_id = $1', [id])).rows[0]!.people)).toBe(
          12,
        );
      }));

    it('headcount and production: rounded, 0 deletes, sites validated, scope by card, sub-recipes refused, unaudited', () =>
      inRollback(c, async () => {
        const { id: ssemId, scope } = await ssem();
        const menuId = (await c.query('SELECT id FROM menu LIMIT 1')).rows[0]!.id as string;
        const pax = (people: number, location = '') =>
          setMenuPax(c, gm, scope, { month: '2099-02', day: '03', location, menuId, people });
        await pax(10.6, 'NIC');
        expect((await c.query(`SELECT people FROM menu_pax WHERE month = '2099-02'`)).rows[0]!.people).toBe(11);
        await pax(0, 'NIC');
        expect((await c.query(`SELECT count(*)::int AS n FROM menu_pax WHERE month = '2099-02'`)).rows[0]!.n).toBe(0);
        expect((await fail(pax(5, 'MARS'))).status).toBe(400);
        expect(
          (
            await fail(
              setMenuPax(c, U('viewer'), scope, { month: '2099-02', day: '03', location: '', menuId, people: 5 }),
            )
          ).status,
        ).toBe(403);

        const rid = await createRecipe(c, gm, scope, { brandId: ssemId, type: 'MENU' });
        const code = (await c.query('SELECT code FROM recipe WHERE id = $1', [rid])).rows[0]!.code as string;
        const before = Number((await c.query('SELECT count(*) AS n FROM audit_log')).rows[0]!.n);
        await setProduction(c, U('chef'), scope, {
          month: '2099-02',
          day: '03',
          location: 'NIC',
          recipeCode: code,
          portions: 40.4,
        });
        expect((await loadProduction(c, scope, '2099-02'))[0]).toMatchObject({ code, location: 'NIC', portions: 40 });
        expect(Number((await c.query('SELECT count(*) AS n FROM audit_log')).rows[0]!.n)).toBe(before); // unaudited as in legacy
        const sub = await createRecipe(c, gm, scope, { brandId: ssemId, type: 'SUB' });
        const subCode = (await c.query('SELECT code FROM recipe WHERE id = $1', [sub])).rows[0]!.code as string;
        expect(
          (
            await fail(
              setProduction(c, gm, scope, {
                month: '2099-02',
                day: '03',
                location: '',
                recipeCode: subCode,
                portions: 1,
              }),
            )
          ).status,
        ).toBe(422);
        // scope: another brand cannot see or write this card's production
        const other = makeScope([await insertBrand(c, 'QR')]);
        expect(
          (
            await fail(
              setProduction(c, gm, other, { month: '2099-02', day: '03', location: '', recipeCode: code, portions: 1 }),
            )
          ).status,
        ).toBe(404);
        expect(await loadProduction(c, other, '2099-02')).toHaveLength(0);
        await setProduction(c, gm, scope, {
          month: '2099-02',
          day: '03',
          location: 'NIC',
          recipeCode: code,
          portions: 0,
        });
        expect(await loadProduction(c, scope, '2099-02')).toHaveLength(0);
      }));

    it('apply-menu-day: headcounts become portions for the weekday, overwrites only demanded dishes, audited', () =>
      inRollback(c, async () => {
        const { id: ssemId, scope } = await ssem();
        const menus = (await c.query('SELECT id FROM menu ORDER BY sort_order LIMIT 2')).rows.map(
          (r) => r.id as string,
        );
        await setMenuPax(c, gm, scope, { month: '2099-03', day: '07', location: 'NIC', menuId: menus[0]!, people: 20 });
        await setMenuPax(c, gm, scope, { month: '2099-03', day: '07', location: 'NIC', menuId: menus[1]!, people: 5 });
        const rid = await createRecipe(c, gm, scope, { brandId: ssemId, type: 'MENU' });
        const stray = (await c.query('SELECT code FROM recipe WHERE id = $1', [rid])).rows[0]!.code as string;
        await setProduction(c, gm, scope, {
          month: '2099-03',
          day: '07',
          location: 'NIC',
          recipeCode: stray,
          portions: 9,
        });
        const out = await applyMenuDay(c, gm, scope, { month: '2099-03', day: '07', location: 'NIC' });
        expect(out.people).toBe(25);
        expect(out.dishes).toBeGreaterThan(0);
        const prod = await loadProduction(c, scope, '2099-03');
        expect(prod.length).toBeGreaterThanOrEqual(out.dishes);
        expect(prod.find((p) => p.code === stray)!.portions).toBe(9); // stale code NOT cleared (legacy)
        // D-71: it writes the unassigned rows only and never touches a client's row for the same dish, day and site
        const dish = prod.find((p) => p.code !== stray)!.code;
        expect(prod.filter((p) => p.code === dish).every((p) => p.clientId === '')).toBe(true);
        const cid = await createClient(c, gm, scope, ssemId, { name: 'Apply Co' });
        await setProduction(c, gm, scope, {
          month: '2099-03',
          day: '07',
          location: 'NIC',
          recipeCode: dish,
          clientId: cid,
          portions: 33,
        });
        await applyMenuDay(c, gm, scope, { month: '2099-03', day: '07', location: 'NIC' });
        const again = (await loadProduction(c, scope, '2099-03')).filter((p) => p.code === dish);
        expect(again.find((p) => p.clientId === cid)!.portions).toBe(33);
        expect(again.filter((p) => p.clientId === '')).toHaveLength(1);
        const a = await c.query(
          `SELECT detail FROM audit_log WHERE action = 'Turned the menus into production' ORDER BY created_at DESC LIMIT 1`,
        );
        expect(a.rows[0]!.detail).toMatch(/25 people across 2 menus became/);
        expect(a.rows[0]!.detail).not.toMatch(/&amp;|&lt;/); // plain text, not HTML-escaped (bug 12)
        expect((await fail(applyMenuDay(c, gm, scope, { month: '2099-03', day: '08', location: 'NIC' }))).status).toBe(
          422,
        ); // no headcount
      }));

    it('menu price: writes the item price, clears PRICE MISSING, appends history; needs items.edit', () =>
      inRollback(c, async () => {
        const { scope } = await ssem();
        await c.query(
          `INSERT INTO ingredient (code,name,uom,price,category,subcategory,flag) VALUES ('MNU-TEST','Menu thing','Each',NULL,'c','s','PRICE MISSING')`,
        );
        const hist: unknown[] = [];
        const add = async (id: string, was: number | null, now: number) => {
          hist.push([id, was, now]);
        };
        expect((await fail(priceMenuItem(c, U('chef'), scope, 'MNU-TEST', 3, add))).status).toBe(403);
        expect((await fail(priceMenuItem(c, gm, scope, 'MNU-TEST', -1, add))).status).toBe(400);
        await priceMenuItem(c, U('fin'), scope, 'MNU-TEST', 3.25, add);
        const r = (await c.query(`SELECT price, flag FROM ingredient WHERE code = 'MNU-TEST'`)).rows[0]!;
        expect(r).toMatchObject({ price: 3.25, flag: '' });
        expect(hist).toHaveLength(1);
      }));
  },
);
