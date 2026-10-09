import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';

/** Opt-in (SQL_TRACE=1): counts the statements a request runs and the time spent waiting on them. */
export interface SqlStats {
  n: number;
  ms: number;
  /** first words of each statement, only with SQL_TRACE=2 */
  q?: string[];
}

// Next can bundle this module more than once (the pool outlives a bundle), so the storage lives on globalThis.
const g = globalThis as unknown as { __sqlAls?: AsyncLocalStorage<SqlStats> };
const als = (g.__sqlAls ??= new AsyncLocalStorage<SqlStats>());

export const sqlTraceOn = () => process.env.SQL_TRACE === '1' || process.env.SQL_TRACE === '2';

/** Run fn with a fresh counter; the returned stats are undefined when tracing is off. */
export async function withSqlStats<T>(fn: () => Promise<T>): Promise<{ out: T; stats?: SqlStats }> {
  if (!sqlTraceOn()) return { out: await fn() };
  const stats: SqlStats = { n: 0, ms: 0, ...(process.env.SQL_TRACE === '2' ? { q: [] } : {}) };
  const out = await als.run(stats, fn);
  return { out, stats };
}

/** Wrap each new pooled client's query() so statements are counted against the current request. */
export function traceClients(pool: Pool): void {
  if (!sqlTraceOn()) return;
  pool.on('connect', (client) => {
    const original = client.query.bind(client) as (...a: unknown[]) => unknown;
    (client as unknown as { query: (...a: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const stats = als.getStore();
      if (!stats) return original(...args);
      stats.n += 1;
      const first = args[0];
      stats.q?.push(
        (typeof first === 'string' ? first : ((first as { text?: string })?.text ?? ''))
          .replace(/\s+/g, ' ')
          .slice(0, 70),
      );
      const t = performance.now();
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        // callback style (pool.query goes through here)
        args[args.length - 1] = (...cb: unknown[]) => {
          stats.ms += performance.now() - t;
          return (last as (...a: unknown[]) => unknown)(...cb);
        };
        return original(...args);
      }
      const res = original(...args);
      return res instanceof Promise
        ? res.finally(() => {
            stats.ms += performance.now() - t;
          })
        : res;
    };
  });
}
