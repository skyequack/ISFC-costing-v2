import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { getEnv } from '../env';
import { normalizeConnectionString } from './conn';

/** Anything that can run a query: the pool, a transaction client, or a test fake. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

const g = globalThis as unknown as { __pool?: Pool };

/**
 * One pg Pool per runtime instance, on the POOLED Neon URL (DATABASE_URL, "-pooler" host).
 * Vercel Fluid compute reuses the instance across requests; attachDatabasePool closes idle
 * connections before the instance is suspended. Migrations/seed/import use DATABASE_URL_UNPOOLED
 * through their own clients (scripts/migrate.mjs, db seed scripts) — never this pool.
 */
export function getPool(): Pool {
  if (!g.__pool) {
    const pool = new Pool({
      connectionString: normalizeConnectionString(getEnv().DATABASE_URL),
      max: 10,
      idleTimeoutMillis: 5000,
    });
    attachDatabasePool(pool);
    g.__pool = pool;
  }
  return g.__pool;
}

/** Lazy Queryable over the shared pool (importing this module never opens a connection). */
export const db: Queryable = {
  query: (text, values) => getPool().query(text, values),
};

/**
 * Run fn in one transaction on a dedicated connection. Transaction-scoped features
 * (pg_advisory_xact_lock, SELECT ... FOR UPDATE) are safe through Neon's pooler in transaction mode.
 */
export async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already broken — surface the original error */
    }
    throw e;
  } finally {
    client.release();
  }
}

/** Postgres SQLSTATE of a pg error, e.g. '23505' unique_violation, '40001' serialization_failure. */
export function pgErrorCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;
}
