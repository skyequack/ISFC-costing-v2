import { ApiError } from '../errors';
import { log } from '../logger';
import { RATE_RULES, type RateClass } from './budgets';

/** What the counter store answers for one hit: how many requests this user has made in the window, and when it ends. */
export interface RateHit {
  n: number;
  /** whole seconds until the window ends (at least 1) */
  retryAfter: number;
}

export interface RateStore {
  hit(userId: string, cls: RateClass, windowSec: number): Promise<RateHit>;
}

/** The store gets this long to answer before the request is decided by the class's failure mode (D-89). */
export const STORE_TIMEOUT_MS = 200;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('rate limit store timed out')), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * Count one request for `userId` in `cls` and refuse it when the window's budget is spent (D-87).
 * Over budget: ApiError 429 `rate_limited` with `retryAfter`. Store error or timeout: fail closed (`internal`) for the classes
 * that say so, otherwise let the request through after one warning (D-89). Never logs more than the class and the reason.
 */
export async function checkRate(
  store: RateStore,
  userId: string,
  cls: RateClass,
  timeoutMs: number = STORE_TIMEOUT_MS,
): Promise<void> {
  const rule = RATE_RULES[cls];
  let hit: RateHit;
  try {
    hit = await withTimeout(store.hit(userId, cls, rule.windowSec), timeoutMs);
  } catch (e) {
    log('warn', 'rate_limit_store_down', {
      cls,
      failClosed: rule.failClosed,
      err: e instanceof Error ? e.message : 'unknown',
    });
    if (rule.failClosed)
      throw new ApiError('internal', 'Could not check the request limit just now. Try again shortly.');
    return;
  }
  if (hit.n > rule.budget) {
    throw new ApiError(
      'rate_limited',
      'Too many requests. Try again shortly.',
      undefined,
      Math.max(1, Math.ceil(hit.retryAfter)),
    );
  }
}
