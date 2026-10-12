import { db, type Queryable } from '../db/client';
import type { RateClass } from './budgets';
import type { RateHit, RateStore } from './limiter';

/** Rows older than this (seconds) are removed; the longest window is one hour. */
const KEEP_SECONDS = 7200;
/** About one call in this many also deletes old rows, so the table needs no scheduled job. */
const CLEANUP_ONE_IN = 50;

/**
 * The counter lives in Neon (migration 0008). One statement: the window is the DATABASE clock rounded down to the class's
 * window length, the upsert is atomic, and it runs on the pooled connection in autocommit, so it never joins (or is rolled
 * back with) the request's own transaction and the row lock is held for about a millisecond.
 */
export function pgRateStore(q: Queryable = db, random: () => number = Math.random): RateStore {
  return {
    async hit(userId: string, cls: RateClass, windowSec: number): Promise<RateHit> {
      const { rows } = await q.query<{ n: number; retry_after: number }>(
        `WITH w AS (
           SELECT floor(extract(epoch FROM now()))::bigint AS t, $3::bigint AS len
         )
         INSERT INTO rate_limit (user_id, cls, window_start, n)
         SELECT $1, $2, (t / len) * len, 1 FROM w
         ON CONFLICT (user_id, cls, window_start) DO UPDATE SET n = rate_limit.n + 1
         RETURNING n, greatest(1, window_start + $3::bigint - floor(extract(epoch FROM now()))::bigint)::int AS retry_after`,
        [userId, cls, windowSec],
      );
      const row = rows[0];
      if (!row) throw new Error('rate limit upsert returned no row');
      if (random() * CLEANUP_ONE_IN < 1) {
        void q
          .query(`DELETE FROM rate_limit WHERE window_start < floor(extract(epoch FROM now()))::bigint - $1::bigint`, [
            KEEP_SECONDS,
          ])
          .catch(() => undefined); // best effort; the next call tries again
      }
      return { n: Number(row.n), retryAfter: Number(row.retry_after) };
    },
  };
}
