import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/errors';
import { RATE_RULES } from '@/lib/rate-limit/budgets';
import { checkRate, STORE_TIMEOUT_MS, type RateHit, type RateStore } from '@/lib/rate-limit/limiter';
import { fakeRateStore } from './helpers/rate-store';
import { pgRateStore } from '@/lib/rate-limit/store';

const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ log: warn }));

/** The error a refused request throws; fails the test if the request was let through. */
async function refused(p: Promise<void>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected the request to be refused');
}

const status = async (p: Promise<void>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof ApiError ? e.status : 0;
  }
};

describe('checkRate: fixed window per user and class (D-87, D-88)', () => {
  const clock = { now: 7_200_000 };
  let store: ReturnType<typeof fakeRateStore>;
  beforeEach(() => {
    warn.mockReset();
    clock.now = 7_200_000; // a multiple of every window length (60 s, 10 min, 1 h), so each window starts exactly here
    store = fakeRateStore(clock);
  });

  it('allows exactly the budget and refuses the next request with a 429 and a Retry-After', async () => {
    const { budget, windowSec } = RATE_RULES.restore;
    for (let i = 0; i < budget; i++) await checkRate(store, 'u1', 'restore');
    const err = await refused(checkRate(store, 'u1', 'restore'));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfter).toBe(windowSec); // the whole window is still ahead
    expect(err.details).toBeUndefined(); // nothing about counts or windows in the body
  });

  it('Retry-After counts down to the window end and is never below 1', async () => {
    const { budget, windowSec } = RATE_RULES.upload;
    for (let i = 0; i < budget; i++) await checkRate(store, 'u1', 'upload');
    clock.now += windowSec - 1; // the last second of the window
    const err = await refused(checkRate(store, 'u1', 'upload'));
    expect(err.retryAfter).toBe(1);
  });

  it('a new window starts with a fresh count', async () => {
    const { budget, windowSec } = RATE_RULES.upload;
    for (let i = 0; i <= budget; i++) await status(checkRate(store, 'u1', 'upload'));
    expect(await status(checkRate(store, 'u1', 'upload'))).toBe(429);
    clock.now += windowSec; // boundary: t = start + window belongs to the next window
    expect(await status(checkRate(store, 'u1', 'upload'))).toBe(200);
  });

  it('users and classes do not share a budget', async () => {
    const { budget } = RATE_RULES.restore;
    for (let i = 0; i <= budget; i++) await status(checkRate(store, 'u1', 'restore'));
    expect(await status(checkRate(store, 'u1', 'restore'))).toBe(429);
    expect(await status(checkRate(store, 'u2', 'restore'))).toBe(200); // another user
    expect(await status(checkRate(store, 'u1', 'restore_chunk'))).toBe(200); // another class of the same user
  });

  it('every class has a positive whole budget and window, and the fail-closed set is exactly restore, chunks and user admin', () => {
    for (const [cls, r] of Object.entries(RATE_RULES)) {
      expect(Number.isInteger(r.budget) && r.budget > 0, cls).toBe(true);
      expect(Number.isInteger(r.windowSec) && r.windowSec >= 60, cls).toBe(true);
    }
    expect(
      Object.entries(RATE_RULES)
        .filter(([, r]) => r.failClosed)
        .map(([c]) => c)
        .sort(),
    ).toEqual(['restore', 'restore_chunk', 'user_admin']);
  });
});

describe('checkRate: when the counter store is down (D-89)', () => {
  beforeEach(() => warn.mockReset());
  const broken: RateStore = {
    hit: () => Promise.reject(new Error('connection refused')),
  };
  const hung: RateStore = { hit: () => new Promise<RateHit>(() => undefined) };

  it('fails open for an ordinary class, with one warning and no throw', async () => {
    await expect(checkRate(broken, 'u1', 'export_kind')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toBe('rate_limit_store_down');
  });

  it('fails closed (an internal error, not a 429) for restore, restore chunks and user admin', async () => {
    for (const cls of ['restore', 'restore_chunk', 'user_admin'] as const) {
      const err = await refused(checkRate(broken, 'u1', cls));
      expect(err, cls).toBeInstanceOf(ApiError);
      expect(err.code, cls).toBe('internal');
      expect(err.retryAfter).toBeUndefined();
    }
  });

  it('a store that never answers is cut off at the timeout instead of hanging the request', async () => {
    expect(STORE_TIMEOUT_MS).toBeLessThanOrEqual(300);
    await expect(checkRate(hung, 'u1', 'import', 20)).resolves.toBeUndefined();
    const err = await refused(checkRate(hung, 'u1', 'restore', 20));
    expect(err.code).toBe('internal');
  });
});

describe('pgRateStore: the single statement', () => {
  it('sends one upsert with the user, class and window length, and maps the answer', async () => {
    const query = vi.fn(async () => ({ rows: [{ n: 3, retry_after: 42 }] }));
    const hit = await pgRateStore({ query } as never, () => 0.99).hit('c_1', 'import', 600);
    expect(hit).toEqual({ n: 3, retryAfter: 42 });
    expect(query).toHaveBeenCalledTimes(1); // no cleanup on this call
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(values).toEqual(['c_1', 'import', 600]);
    expect(sql).toMatch(/INSERT INTO rate_limit/);
    expect(sql).toMatch(/ON CONFLICT \(user_id, cls, window_start\) DO UPDATE SET n = rate_limit\.n \+ 1/);
    expect(sql).toMatch(/extract\(epoch FROM now\(\)\)/); // the database clock, not the app's
  });

  it('about one call in fifty also deletes old rows, best effort', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ n: 1, retry_after: 5 }] })
      .mockRejectedValueOnce(new Error('cleanup failed')); // must not surface
    const hit = await pgRateStore({ query } as never, () => 0).hit('c_1', 'upload', 60);
    expect(hit.n).toBe(1);
    await Promise.resolve();
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1]![0])).toMatch(/DELETE FROM rate_limit WHERE window_start </);
  });

  it('an empty answer is an error (so the class failure mode decides)', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(pgRateStore({ query } as never).hit('c_1', 'upload', 60)).rejects.toThrow(/no row/);
  });
});
