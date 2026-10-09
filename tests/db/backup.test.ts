import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import { ApiError } from '@/lib/errors';
import { pgImageStore, validateImage } from '@/lib/images';
import type { Role } from '@/lib/permissions';
import { applyRestore, backupSchema, buildBackupCore, buildImageChunk } from '@/lib/services/backup';
import { chunkIn, runRestore, storeChunk } from '@/lib/services/restore';
import { connect, hasTestDb, inRollback } from './helpers';

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

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w: number, h: number) =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    0x49,
    0x48,
    0x44,
    0x52,
    ...be32(w),
    ...be32(h),
    8,
    6,
    0,
    0,
    0,
    1,
    2,
    3,
  ]);

describe.skipIf(!hasTestDb)('backup and restore (D-37) against the seeded dev data', { timeout: 280_000 }, () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await connect();
  }, 60_000);
  afterAll(async () => {
    await c.end();
  });

  /** a deliberately small backup (3 ingredients, 1 card) keeps the network-bound tests fast */
  const small = async () => {
    const core = JSON.parse(JSON.stringify(await buildBackupCore(c, gm)));
    core.ingredients = core.ingredients.slice(0, 3);
    core.recipes = [{ ...core.recipes[0], lines: core.recipes[0].lines.slice(0, 2), history: [] }];
    core.menus = [];
    core.menuPax = [];
    core.production = [];
    return core;
  };

  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          'ingredient',
          'recipe',
          'recipe_line',
          'unit_conversion',
          'brand',
          'menu',
          'menu_cell',
          'menu_pax',
          'production_entry',
          'item_brand_scope',
        ].map(async (t) => [
          t,
          Number(
            (await c.query(`SELECT count(*) AS n FROM ${t}${t === 'recipe' ? ' WHERE deleted_at IS NULL' : ''}`))
              .rows[0]!.n,
          ),
        ]),
      ),
    );

  it('only the General Manager can export or restore', async () => {
    expect((await fail(buildBackupCore(c, U('cc')))).status).toBe(403);
    expect((await fail(buildImageChunk(c, U('fin'), 'photos', 0))).status).toBe(403);
    await fail(storeChunk(c, U('chef'), { session: 'a'.repeat(20), seq: 0, data: '{}' }));
  });

  it('a backup of the live data validates against the schema, and restoring it changes nothing (all rows updated, none removed)', () =>
    inRollback(c, async () => {
      const core = await buildBackupCore(c, gm);
      expect(backupSchema.safeParse(core).success).toBe(true);
      expect(core.recipes.length).toBe(321);
      expect(core.ingredients.length).toBe(1046);
      const before = await counts();
      const stats = await applyRestore(c, gm, backupSchema.parse(JSON.parse(JSON.stringify(core))), 'self.json');
      expect(stats.recipes).toMatchObject({ added: 0, updated: 321, removed: 0 });
      expect(stats.ingredients).toMatchObject({ added: 0, updated: 1046, keptNotInBackup: 0 });
      expect(await counts()).toEqual(before);
      // doubles survive the JSON round trip bit-for-bit
      const again = await buildBackupCore(c, gm);
      expect(again.ingredients).toEqual(core.ingredients);
      expect(again.recipes).toEqual(core.recipes);
      expect(again.menus).toEqual(core.menus);
      const a = await c.query(
        `SELECT detail FROM audit_log WHERE action = 'Restored a backup' ORDER BY created_at DESC LIMIT 1`,
      );
      expect(a.rows[0]!.detail).toContain('self.json');
    }));

  it('restore applies price/card changes, soft-deletes cards the backup lacks, keeps extra ingredients, never touches the audit log', () =>
    inRollback(c, async () => {
      const core = await small();
      const keep = core.recipes[0].code;
      core.ingredients[0].price = 123.456;
      const total = Number((await c.query('SELECT count(*) AS n FROM recipe WHERE deleted_at IS NULL')).rows[0]!.n);
      const auditBefore = Number((await c.query('SELECT count(*) AS n FROM audit_log')).rows[0]!.n);
      const stats = await applyRestore(c, gm, backupSchema.parse(core), 'edited.json');
      expect(stats.recipes).toMatchObject({ added: 0, updated: 1, removed: total - 1 });
      expect(stats.ingredients.keptNotInBackup).toBe(1046 - 3);
      expect((await c.query('SELECT count(*)::int AS n FROM recipe WHERE deleted_at IS NULL')).rows[0]!.n).toBe(1);
      expect((await c.query('SELECT code FROM recipe WHERE deleted_at IS NULL')).rows[0]!.code).toBe(keep);
      expect(
        (await c.query('SELECT price FROM ingredient WHERE code = $1', [core.ingredients[0].code])).rows[0]!.price,
      ).toBe(123.456);
      expect(Number((await c.query('SELECT count(*) AS n FROM audit_log')).rows[0]!.n)).toBe(auditBefore + 1); // only the restore entry
    }));

  it('refuses inconsistent backups: duplicate codes, ingredient/card clash, unknown brand, circular recipes', () =>
    inRollback(c, async () => {
      const base = JSON.parse(JSON.stringify(await buildBackupCore(c, gm)));
      const tryIt = async (mut: (b: typeof base) => void) => {
        const b = JSON.parse(JSON.stringify(base));
        mut(b);
        return fail(applyRestore(c, gm, backupSchema.parse(b), 'bad.json'));
      };
      expect((await tryIt((b) => b.recipes.push({ ...b.recipes[0] }))).status).toBe(422);
      expect((await tryIt((b) => (b.recipes[0].code = b.ingredients[0].code))).message).toMatch(
        /both an ingredient and a card/,
      );
      expect((await tryIt((b) => (b.recipes[0].brandCode = 'NOPE'))).message).toMatch(/unknown brand/);
      expect(
        (
          await tryIt((b) => {
            const sub = b.recipes.find((r: { type: string }) => r.type === 'SUB');
            sub.lines.push({ code: sub.code, qty: 1, unit: 'Gram', y: 1, yp: null });
          })
        ).message,
      ).toMatch(/Circular|circular/);
      expect(backupSchema.safeParse({ ...base, version: 2 }).success).toBe(false);
      expect(backupSchema.safeParse({ ...base, settings: { ...base.settings, pkg: Number.NaN } }).success).toBe(false);
    }));

  it('images travel in separate parts and are restored through the ImageStore (validated); a data-only backup leaves pictures alone', () =>
    inRollback(c, async () => {
      const recipe = (await c.query('SELECT id, code FROM recipe WHERE deleted_at IS NULL ORDER BY code LIMIT 1'))
        .rows[0]!;
      const bytes = png(40, 30);
      await pgImageStore(c, 'photo').put(recipe.id, validateImage(bytes, 'photo'), bytes);
      const chunk = await buildImageChunk(c, gm, 'photos', 0);
      const mine = chunk.items.find((i) => i.code === recipe.code)!;
      expect(Buffer.from(mine.data, 'base64')).toEqual(Buffer.from(bytes));
      const logos = await buildImageChunk(c, gm, 'logos', 0);
      expect(logos.items.length).toBeGreaterThan(0);

      const core = await small();
      core.recipes = [{ ...core.recipes[0], code: recipe.code, lines: [] }];
      await applyRestore(c, gm, backupSchema.parse(core), 'data-only.json'); // no images -> untouched
      expect((await pgImageStore(c, 'photo').meta(recipe.id))?.width).toBe(40);
      await applyRestore(c, gm, backupSchema.parse({ ...core, photos: [] }), 'with-empty-photos.json'); // images included, none -> cleared
      expect(await pgImageStore(c, 'photo').meta(recipe.id)).toBeNull();
      await applyRestore(
        c,
        gm,
        backupSchema.parse({
          ...core,
          photos: [{ recipeCode: recipe.code, data: Buffer.from(bytes).toString('base64') }],
        }),
        'photo.json',
      );
      expect((await pgImageStore(c, 'photo').meta(recipe.id))?.width).toBe(40);
      await expect(
        applyRestore(
          c,
          gm,
          backupSchema.parse({
            ...core,
            photos: [{ recipeCode: recipe.code, data: Buffer.from('<svg/>').toString('base64') }],
          }),
          'evil.json',
        ),
      ).rejects.toBeInstanceOf(ApiError);
    }));

  it('staged upload: chunks are ordered, owned by the uploader, dry-run rolls everything back, commit applies and clears the staging rows', () =>
    inRollback(c, async () => {
      const core = await small();
      core.settings.pkg = 0.123;
      const text = JSON.stringify(core);
      const parts = [text.slice(0, 3000), text.slice(3000, 6000), text.slice(6000)].filter(Boolean);
      const session = 'sess-' + 'x'.repeat(20);
      const send = async (user: SessionUser, i: number, data: string) =>
        storeChunk(c, user, chunkIn.parse({ session, seq: i, data }));
      for (let i = 0; i < parts.length; i++) await send(gm, i, parts[i]!);
      expect((await fail(send(U('gm', 'other'), 0, 'x'))).status).toBe(403);
      expect((await fail(runRestore(c, gm, { session, total: parts.length + 1, file: 'x' }, 'dry-run'))).status).toBe(
        400,
      ); // incomplete
      const dry = await runRestore(c, gm, { session, total: parts.length, file: 'staged.json' }, 'dry-run');
      expect(dry.recipes.updated).toBe(1);
      expect((await c.query('SELECT pkg FROM cost_settings')).rows[0]!.pkg).not.toBe(0.123); // rolled back
      expect(
        Number((await c.query('SELECT count(*) AS n FROM restore_chunk WHERE session_id = $1', [session])).rows[0]!.n),
      ).toBe(parts.length);
      await runRestore(c, gm, { session, total: parts.length, file: 'staged.json' }, 'commit');
      expect((await c.query('SELECT pkg FROM cost_settings')).rows[0]!.pkg).toBe(0.123);
      expect(
        Number((await c.query('SELECT count(*) AS n FROM restore_chunk WHERE session_id = $1', [session])).rows[0]!.n),
      ).toBe(0);
      // garbage upload
      await storeChunk(c, gm, chunkIn.parse({ session: 'garbage-' + 'y'.repeat(16), seq: 0, data: 'not json' }));
      expect(
        (await fail(runRestore(c, gm, { session: 'garbage-' + 'y'.repeat(16), total: 1, file: 'g' }, 'dry-run')))
          .status,
      ).toBe(400);
    }));
});
