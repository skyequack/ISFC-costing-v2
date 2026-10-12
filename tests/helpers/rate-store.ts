import type { RateClass } from '@/lib/rate-limit/budgets';
import type { RateHit, RateStore } from '@/lib/rate-limit/limiter';

/** The same fixed-window maths as the SQL in src/lib/rate-limit/store.ts, on an injected clock (whole seconds). */
export function fakeRateStore(clock: { now: number }): RateStore & { calls: number } {
  const rows = new Map<string, number>();
  const s = {
    calls: 0,
    async hit(userId: string, cls: RateClass, windowSec: number): Promise<RateHit> {
      s.calls++;
      const start = Math.floor(clock.now / windowSec) * windowSec;
      const key = `${userId}|${cls}|${start}`;
      const n = (rows.get(key) ?? 0) + 1;
      rows.set(key, n);
      return { n, retryAfter: Math.max(1, start + windowSec - Math.floor(clock.now)) };
    },
  };
  return s;
}
