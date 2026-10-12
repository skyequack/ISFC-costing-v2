import type { RateClass } from './budgets';
import { checkRate } from './limiter';
import { pgRateStore } from './store';

export { RATE_RULES, type RateClass } from './budgets';

const store = pgRateStore();

/** What withAuth calls for a route that declares `limit` (D-87). Throws ApiError; returns when the request may go on. */
export function enforceRateLimit(userId: string, cls: RateClass): Promise<void> {
  return checkRate(store, userId, cls);
}
