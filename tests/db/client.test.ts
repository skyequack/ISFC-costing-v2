import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasTestDb, TEST_DB_URL } from './helpers';

/** Rolls back a withTransaction callback after assertions without surfacing as a failure. */
class Rollback extends Error {}

describe.skipIf(!hasTestDb)('src/lib/db against Neon (pooled URL, real pg Pool)', () => {
  let mod: typeof import('@/lib/db/client');
  let scope: typeof import('@/lib/db/scope');

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: process.env.TEST_DATABASE_POOLED_URL || TEST_DB_URL,
      DATABASE_URL_UNPOOLED: TEST_DB_URL,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_x',
      CLERK_SECRET_KEY: 'sk_test_x',
    });
    mod = await import('@/lib/db/client');
    scope = await import('@/lib/db/scope');
  });

  afterAll(async () => {
    await mod.getPool().end();
  });

  it('runs a query through the pool', async () => {
    const { rows } = await mod.db.query<{ one: number }>('SELECT 1 AS one');
    expect(rows[0]!.one).toBe(1);
  });

  it('withTransaction commits on success and rolls back on error', async () => {
    const tag = `ci-${Math.random().toString(36).slice(2, 10)}`;
    try {
      await expect(
        mod.withTransaction(async (tx) => {
          await tx.query(`INSERT INTO brand (legacy_id, code, name) VALUES ($1, $1, $1)`, [`${tag}-rolled`]);
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect((await mod.db.query('SELECT 1 FROM brand WHERE legacy_id = $1', [`${tag}-rolled`])).rows).toHaveLength(0);

      await mod.withTransaction(async (tx) => {
        await tx.query(`INSERT INTO brand (legacy_id, code, name) VALUES ($1, $1, $1)`, [`${tag}-kept`]);
      });
      expect((await mod.db.query('SELECT 1 FROM brand WHERE legacy_id = $1', [`${tag}-kept`])).rows).toHaveLength(1);
    } finally {
      await mod.db.query('DELETE FROM brand WHERE legacy_id LIKE $1', [`${tag}%`]);
    }
  });

  it('exposes SQLSTATE through pgErrorCode (unique violation 23505)', async () => {
    const tag = `ci-${Math.random().toString(36).slice(2, 10)}`;
    try {
      await mod.db.query(`INSERT INTO brand (legacy_id, code, name) VALUES ($1, $1, $1)`, [tag]);
      const err = await mod.db
        .query(`INSERT INTO brand (legacy_id, code, name) VALUES ($1, $1, $1)`, [tag])
        .catch((e) => e);
      expect(mod.pgErrorCode(err)).toBe('23505');
    } finally {
      await mod.db.query('DELETE FROM brand WHERE legacy_id = $1', [tag]);
    }
  });

  it('visibleBrandIds: GM sees all brands, a non-GM only granted ones, none sees nothing', async () => {
    await expect(
      mod.withTransaction(async (tx) => {
        const b1 = (
          await tx.query<{ id: string }>(
            `INSERT INTO brand (legacy_id, code, name) VALUES ('t-b1','t-b1','t-b1') RETURNING id`,
          )
        ).rows[0]!.id;
        const b2 = (
          await tx.query<{ id: string }>(
            `INSERT INTO brand (legacy_id, code, name) VALUES ('t-b2','t-b2','t-b2') RETURNING id`,
          )
        ).rows[0]!.id;
        const u = (
          await tx.query<{ id: string }>(`INSERT INTO app_user (clerk_user_id, name) VALUES ('t-u','t') RETURNING id`)
        ).rows[0]!.id;
        const none = (
          await tx.query<{ id: string }>(
            `INSERT INTO app_user (clerk_user_id, name) VALUES ('t-none','t') RETURNING id`,
          )
        ).rows[0]!.id;
        await tx.query('INSERT INTO user_brand_access (user_id, brand_id) VALUES ($1, $2)', [u, b1]);

        const gm = await scope.visibleBrandIds({ id: u, role: 'gm' }, tx);
        expect(gm.brandIds).toEqual(expect.arrayContaining([b1, b2]));
        expect((await scope.visibleBrandIds({ id: u, role: 'cook' }, tx)).brandIds).toEqual([b1]);
        expect((await scope.visibleBrandIds({ id: none, role: 'cc' }, tx)).brandIds).toEqual([]);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  });

  it('first-login provisioning statement is race-safe (parallel upserts return the same row)', async () => {
    const clerkId = `ci_${Math.random().toString(36).slice(2, 10)}`;
    const sql = `INSERT INTO app_user (clerk_user_id, email, name, last_role_seen) VALUES ($1, NULL, 'x', NULL)
       ON CONFLICT (clerk_user_id) DO UPDATE SET clerk_user_id = EXCLUDED.clerk_user_id RETURNING id`;
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => mod.db.query<{ id: string }>(sql, [clerkId])));
      expect(new Set(results.map((r) => r.rows[0]!.id)).size).toBe(1);
    } finally {
      await mod.db.query('DELETE FROM app_user WHERE clerk_user_id = $1', [clerkId]);
    }
  });
});
