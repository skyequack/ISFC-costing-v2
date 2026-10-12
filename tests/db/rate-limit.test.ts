import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/errors';
import { RATE_RULES } from '@/lib/rate-limit/budgets';
import { checkRate } from '@/lib/rate-limit/limiter';
import { pgRateStore } from '@/lib/rate-limit/store';
import { connect, hasTestDb } from './helpers';

/**
 * The counter must COMMIT (a rolled-back count would be no count), so unlike the other DB tests this one runs in autocommit on
 * several real connections and removes its own rows (unique `rltest-` user ids) afterwards. The pg clients here stand in for
 * Fluid instances: the window comes from the database clock, so they cannot disagree.
 */
describe.skipIf(!hasTestDb)('rate_limit counter (D-87)', { timeout: 120_000 }, () => {
  const PREFIX = 'rltest-';
  const uid = (name: string) => `${PREFIX}${name}-${Math.random().toString(36).slice(2, 8)}`;
  let clients: pg.Client[] = [];

  beforeAll(async () => {
    clients = await Promise.all(Array.from({ length: 10 }, () => connect()));
  }, 60_000);
  afterAll(async () => {
    await clients[0]?.query(`DELETE FROM rate_limit WHERE user_id LIKE $1`, [`${PREFIX}%`]);
    await Promise.all(clients.map((c) => c.end()));
  });

  const stores = () => clients.map((c) => pgRateStore(c, () => 1)); // random()=1: no cleanup unless a test asks for it

  it('50 concurrent hits from 10 connections are counted exactly, with no lost updates', async () => {
    const user = uid('count');
    const s = stores();
    const hits = await Promise.all(Array.from({ length: 50 }, (_, i) => s[i % s.length]!.hit(user, 'import', 600)));
    expect(hits.map((h) => h.n).sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    const { rows } = await clients[0]!.query(`SELECT n FROM rate_limit WHERE user_id = $1 AND cls = 'import'`, [user]);
    expect(rows).toHaveLength(1); // one row for the window
    expect(rows[0]!.n).toBe(50);
  });

  it('under concurrency exactly the budget is allowed and the rest are refused with 429', async () => {
    const user = uid('budget');
    const s = stores();
    const { budget } = RATE_RULES.restore;
    const results = await Promise.all(
      Array.from({ length: budget + 15 }, (_, i) =>
        checkRate(s[i % s.length]!, user, 'restore', 20_000).then(
          () => 'allowed',
          (e: unknown) => (e instanceof ApiError ? e.status : 'other'),
        ),
      ),
    );
    expect(results.filter((r) => r === 'allowed')).toHaveLength(budget);
    expect(results.filter((r) => r === 429)).toHaveLength(15);
  });

  it('Retry-After is between 1 and the window length, from the database clock', async () => {
    const user = uid('retry');
    const hit = await stores()[0]!.hit(user, 'upload', 60);
    expect(hit.retryAfter).toBeGreaterThanOrEqual(1);
    expect(hit.retryAfter).toBeLessThanOrEqual(60);
  });

  it('users and classes are separate rows', async () => {
    const a = uid('a');
    const b = uid('b');
    const s = stores()[0]!;
    await s.hit(a, 'upload', 60);
    await s.hit(a, 'upload', 60);
    expect((await s.hit(b, 'upload', 60)).n).toBe(1); // another user
    expect((await s.hit(a, 'import', 600)).n).toBe(1); // another class
    expect((await s.hit(a, 'upload', 60)).n).toBe(3);
  });

  it('a count from an earlier window does not carry over, and cleanup removes old rows but not current ones', async () => {
    const user = uid('old');
    const c = clients[0]!;
    // a row from long ago (two windows back is enough to be a different window; 3 h back is old enough to be cleaned up)
    await c.query(
      `INSERT INTO rate_limit (user_id, cls, window_start, n) VALUES ($1, 'upload', floor(extract(epoch FROM now()))::bigint - 10800, 999)`,
      [user],
    );
    const fresh = await pgRateStore(c, () => 0).hit(user, 'upload', 60); // random()=0: this call also cleans up
    expect(fresh.n).toBe(1); // the old window's 999 does not count
    for (let i = 0; i < 20; i++) {
      const left = await c.query(`SELECT count(*)::int AS k FROM rate_limit WHERE user_id = $1`, [user]);
      if (left.rows[0]!.k === 1) break; // the fire-and-forget delete has run
      await new Promise((r) => setTimeout(r, 100));
    }
    const rows = (await c.query(`SELECT n FROM rate_limit WHERE user_id = $1`, [user])).rows;
    expect(rows).toEqual([{ n: 1 }]); // the old row is gone, the current one stays
  });
});
