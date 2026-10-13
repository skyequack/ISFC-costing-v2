import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import { getRecipe } from '@/lib/db/repo/recipes';
import { makeScope } from '@/lib/db/scope';
import { ApiError } from '@/lib/errors';
import type { Role } from '@/lib/permissions';
import { commitRecipeImport, previewRecipeImport, recipeImportIn } from '@/lib/services/import-recipes';
import { createIngredient, deleteIngredient } from '@/lib/services/ingredients';
import { createRecipe, lockRecipes, saveRecipe, unlockRecipes } from '@/lib/services/recipes';
import { getRevision, listRevisions, startRevision } from '@/lib/services/revisions';
import { connect, hasTestDb, inRollback, insertBrand } from './helpers';

const U = (role: Role): SessionUser => ({
  id: `u-${role}`,
  clerkUserId: `c-${role}`,
  email: null,
  name: `T ${role}`,
  role,
});
const gm = U('gm');

const line = (code: string, qty = 1, extra: Record<string, unknown> = {}) => ({
  code,
  qty,
  unit: 'Gram' as const,
  y: 1,
  yp: null,
  ...extra,
});

async function fail(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected an ApiError but the call succeeded');
}

describe.skipIf(!hasTestDb)(
  'card revisions (D-100, B1) against the database (all rolled back)',
  { timeout: 120_000 },
  () => {
    let c: pg.Client;
    beforeAll(async () => {
      c = await connect();
    }, 60_000);
    afterAll(async () => {
      await c.end();
    });

    async function world() {
      const brand = await insertBrand(c, 'ZR');
      const other = await insertBrand(c, 'YR');
      const scope = makeScope([brand]);
      await createIngredient(c, gm, scope, {
        code: 'RVI',
        name: 'Rev item',
        uom: 'Gram',
        price: 2,
        category: 'c',
        subcategory: 's',
        flag: '',
        brandIds: [],
      });
      return { brand, other, scope };
    }
    /** a card with two lines and a method, started `days` ago */
    async function card(scope: ReturnType<typeof makeScope>, brand: string, days = 5, type: 'MENU' | 'SUB' = 'MENU') {
      const id = await createRecipe(c, gm, scope, { brandId: brand, type, name: 'Rev card' });
      await saveRecipe(c, gm, scope, id, {
        version: 0,
        lines: [line('RVI', 100), line('RVI', 50, { y: 0.9 })],
        method: ['Step one', 'Step two'],
      });
      await c.query(
        `UPDATE recipe SET effective_from = ((now() AT TIME ZONE 'Asia/Riyadh')::date - $2::int) WHERE id = $1`,
        [id, days],
      );
      return id;
    }
    const today = async () =>
      (await c.query(`SELECT ((now() AT TIME ZONE 'Asia/Riyadh')::date)::text AS d`)).rows[0]!.d as string;

    it('a card created today is revision 1 and a second revision the same day is refused (edited in place)', () =>
      inRollback(c, async () => {
        const { brand, scope } = await world();
        const id = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
        const r = await getRecipe(c, scope, id);
        expect([r.revision, r.effectiveFrom]).toEqual([1, await today()]);
        const e = await fail(startRevision(c, gm, scope, id, r.version));
        expect(e.status).toBe(409);
        expect(e.message).toMatch(/already started today/);
        expect((await c.query('SELECT count(*)::int AS n FROM recipe_version')).rows[0]!.n).toBe(0);
      }));

    it('Start new revision archives lines, method and header, starts revision 2 today and bumps the edit version', () =>
      inRollback(c, async () => {
        const { brand, scope } = await world();
        const id = await card(scope, brand);
        const before = await getRecipe(c, scope, id);
        const out = await startRevision(c, gm, scope, id, before.version);
        expect(out).toEqual({ revision: 2, effectiveFrom: await today(), version: before.version + 1 });
        // editing the live card afterwards does not touch the archived one
        await saveRecipe(c, gm, scope, id, { version: out.version, name: 'Changed', lines: [line('RVI', 999)] });
        const list = await listRevisions(c, scope, id);
        expect(list.map((x) => [x.revision, x.effectiveTo])).toEqual([
          [2, null],
          [1, await today()],
        ]);
        expect(list[1]!.effectiveFrom).toBe(before.effectiveFrom);
        const old = await getRevision(c, scope, id, 1);
        expect(old.name).toBe('Rev card');
        expect(old.lines.map((l) => [l.code, l.qty, l.y])).toEqual([
          ['RVI', 100, 1],
          ['RVI', 50, 0.9],
        ]);
        expect(old.method).toEqual(['Step one', 'Step two']);
        expect((await getRecipe(c, scope, id)).name).toBe('Changed');
        const au = await c.query(
          `SELECT detail FROM audit_log WHERE action = 'Started card revision' ORDER BY created_at DESC LIMIT 1`,
        );
        expect(au.rows[0]!.detail).toMatch(/revision 1 → 2 from .* \(button\)/);
        // the same day again is refused
        expect((await fail(startRevision(c, gm, scope, id, out.version + 1))).status).toBe(409);
      }));

    it('refuses a locked card (422), a stale version (409), a viewer (403) and a card out of scope (404)', () =>
      inRollback(c, async () => {
        const { brand, other, scope } = await world();
        const id = await card(scope, brand);
        const v = (await getRecipe(c, scope, id)).version;
        expect((await fail(startRevision(c, gm, scope, id, v + 7))).status).toBe(409);
        expect((await fail(startRevision(c, U('viewer'), scope, id, v))).status).toBe(403);
        expect((await fail(startRevision(c, gm, makeScope([other]), id, v))).status).toBe(404);
        expect((await fail(listRevisions(c, makeScope([other]), id))).status).toBe(404);
        expect((await fail(getRevision(c, makeScope([other]), id, 1))).status).toBe(404);
        expect((await fail(getRevision(c, scope, id, 9))).status).toBe(404); // no such archived revision (the live one is the card)
        await lockRecipes(c, gm, scope, [id], 'Chef');
        expect((await fail(startRevision(c, gm, scope, id, v + 1))).status).toBe(422);
      }));

    it('unlocking an approved card archives the approved revision (with its lock and cost) and starts a draft revision', () =>
      inRollback(c, async () => {
        const { brand, scope } = await world();
        const id = await card(scope, brand);
        await lockRecipes(c, gm, scope, [id], 'Chef');
        await unlockRecipes(c, gm, scope, [id]);
        const live = await getRecipe(c, scope, id);
        expect([live.status, live.revision, live.effectiveFrom, live.lockedBy]).toEqual([
          'DRAFT',
          2,
          await today(),
          null,
        ]);
        const old = await getRevision(c, scope, id, 1);
        expect(old.status).toBe('LOCKED');
        expect(old.lockedBy).toBe('Chef');
        const snap = (await c.query('SELECT cost_at_lock FROM recipe_version WHERE recipe_id = $1', [id])).rows[0]!
          .cost_at_lock;
        expect(snap).toMatchObject({ food: expect.any(Number) });
        const origin = (await c.query('SELECT origin FROM recipe_version WHERE recipe_id = $1', [id])).rows[0]!.origin;
        expect(origin).toBe('UNLOCK');
      }));

    it('a card approved and reopened the day its revision started is reopened in place (nothing to archive)', () =>
      inRollback(c, async () => {
        const { brand, scope } = await world();
        const id = await card(scope, brand, 0);
        await lockRecipes(c, gm, scope, [id], 'Chef');
        await unlockRecipes(c, gm, scope, [id]);
        expect((await getRecipe(c, scope, id)).revision).toBe(1);
        expect((await c.query('SELECT count(*)::int AS n FROM recipe_version')).rows[0]!.n).toBe(0);
      }));

    it('at most 50 revisions per card (422)', () =>
      inRollback(c, async () => {
        const { brand, scope } = await world();
        const id = await card(scope, brand, 1);
        await c.query(
          `INSERT INTO recipe_version (recipe_id, revision, effective_from, effective_to, name, category, type, brand_id, output, sub_qty, sub_uom, batch_out, batch_uom, selling_price, status, origin, created_by)
         SELECT r.id, 100 + g, DATE '2000-01-01' + g, DATE '2000-01-02' + g, r.name, r.category, r.type, r.brand_id, 1, 0, 'Gram', 0, 'Gram', 0, 'DRAFT', 'BUTTON', 'seed'
           FROM recipe r, generate_series(1, 50) g WHERE r.id = $1`,
          [id],
        );
        const v = (await getRecipe(c, scope, id)).version;
        const e = await fail(startRevision(c, gm, scope, id, v));
        expect(e.status).toBe(422);
        expect(e.message).toMatch(/at most 50/);
      }));

    it('renaming a sub-recipe keeps the archived revisions of its parents pointing at it', () =>
      inRollback(c, async () => {
        const { brand, scope } = await world();
        const sub = await createRecipe(c, gm, scope, { brandId: brand, type: 'SUB', name: 'Sub' });
        const subCode = (await getRecipe(c, scope, sub)).code;
        const parent = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU', name: 'Parent' });
        await saveRecipe(c, gm, scope, parent, { version: 0, lines: [line(subCode, 10)] });
        await c.query(
          `UPDATE recipe SET effective_from = ((now() AT TIME ZONE 'Asia/Riyadh')::date - 3) WHERE id = $1`,
          [parent],
        );
        await startRevision(c, gm, scope, parent, 1);
        await saveRecipe(c, gm, scope, sub, { version: 0, code: 'ZR-SR-7777' });
        const old = await getRevision(c, scope, parent, 1);
        expect(old.lines.map((l) => l.code)).toEqual(['ZR-SR-7777']);
      }));

    it('an ingredient used only by an archived revision cannot be deleted', () =>
      inRollback(c, async () => {
        const { brand, scope } = await world();
        const gone = (await createIngredient(c, gm, scope, {
          code: 'RVG',
          name: 'Only old',
          uom: 'Gram',
          price: 1,
          category: 'c',
          subcategory: 's',
          flag: '',
          brandIds: [],
        })) as string;
        const id = await createRecipe(c, gm, scope, { brandId: brand, type: 'MENU' });
        await saveRecipe(c, gm, scope, id, { version: 0, lines: [line('RVG', 5)] });
        await c.query(
          `UPDATE recipe SET effective_from = ((now() AT TIME ZONE 'Asia/Riyadh')::date - 2) WHERE id = $1`,
          [id],
        );
        await startRevision(c, gm, scope, id, 1);
        await saveRecipe(c, gm, scope, id, { version: 2, lines: [line('RVI', 5)] }); // the live card no longer uses it
        const e = await fail(deleteIngredient(c, gm, scope, gone));
        expect(e.status).toBe(409);
        expect(e.message).toMatch(/earlier revisions/);
      }));

    describe('upload of a card whose code exists (D-101)', () => {
      const upload = (code: string, over: Record<string, unknown> = {}, card: Record<string, unknown> = {}) =>
        recipeImportIn.parse({
          cards: [
            {
              code,
              name: 'Rev card',
              lines: [{ code: 'RVI', qty: 77 }],
              ...card,
            },
          ],
          defaultBrandId: over.brandId,
          takePrice: false,
          allowUpdate: false,
          grant: false,
          ...over,
        });

      it('without a choice the card is held back as "exists"; "update" starts a revision first and "new" gets a fresh code', () =>
        inRollback(c, async () => {
          const { brand, scope } = await world();
          const id = await card(scope, brand);
          const code = (await getRecipe(c, scope, id)).code;
          const asked = await previewRecipeImport(c, gm, scope, upload(code, { brandId: brand }));
          expect(asked.cards[0]!.action).toBe('exists');
          // update
          const u = upload(code, { brandId: brand }, { mode: 'update' });
          const plan = await previewRecipeImport(c, gm, scope, u);
          expect(plan.cards[0]!.action).toBe('update');
          const res = await commitRecipeImport(c, gm, scope, { ...u, hash: plan.hash });
          expect(res).toMatchObject({ added: 0, updated: 1, revisions: 1 });
          const live = await getRecipe(c, scope, id);
          expect([live.revision, live.effectiveFrom, live.lines.map((l) => l.qty)]).toEqual([2, await today(), [77]]);
          const old = await getRevision(c, scope, id, 1);
          expect(old.lines.map((l) => l.qty)).toEqual([100, 50]);
          // a second upload the same day updates that day's revision in place
          const u2 = upload(code, { brandId: brand }, { mode: 'update', lines: [{ code: 'RVI', qty: 5 }] });
          const p2 = await previewRecipeImport(c, gm, scope, u2);
          expect(await commitRecipeImport(c, gm, scope, { ...u2, hash: p2.hash })).toMatchObject({
            updated: 1,
            revisions: 0,
          });
          expect((await getRecipe(c, scope, id)).revision).toBe(2);
          // new code: the old card is left alone
          const n = upload(code, { brandId: brand }, { mode: 'new', lines: [{ code: 'RVI', qty: 9 }] });
          const pn = await previewRecipeImport(c, gm, scope, n);
          expect(pn.cards[0]!.action).toBe('add');
          const rn = await commitRecipeImport(c, gm, scope, { ...n, hash: pn.hash });
          expect(rn).toMatchObject({ added: 1, updated: 0 });
          const codes = (
            await c.query(`SELECT code FROM recipe WHERE brand_id = $1 AND deleted_at IS NULL ORDER BY code`, [brand])
          ).rows.map((r) => r.code);
          expect(codes).toHaveLength(2);
          expect(codes).toContain(code);
          expect((await getRecipe(c, scope, id)).lines.map((l) => l.qty)).toEqual([5]);
        }));

      it('the choice is part of the hash (a changed choice cannot reuse an old check) and a locked card stays locked', () =>
        inRollback(c, async () => {
          const { brand, scope } = await world();
          const id = await card(scope, brand);
          const code = (await getRecipe(c, scope, id)).code;
          const u = upload(code, { brandId: brand }, { mode: 'update' });
          const plan = await previewRecipeImport(c, gm, scope, u);
          const flipped = upload(code, { brandId: brand }, { mode: 'new' });
          expect((await fail(commitRecipeImport(c, gm, scope, { ...flipped, hash: plan.hash }))).status).toBe(409);
          await lockRecipes(c, gm, scope, [id], 'Chef');
          const locked = await previewRecipeImport(c, gm, scope, u);
          expect(locked.cards[0]!.action).toBe('locked');
        }));
    });
  },
);
