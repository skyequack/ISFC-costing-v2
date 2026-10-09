import pg from 'pg';
import { normalizeConnectionString } from '@/lib/db/conn';

/**
 * Database tests run only when TEST_DATABASE_URL (a direct/unpooled URL of a migrated Neon branch) is set:
 * CI creates a throwaway branch per run; locally point it at the `dev` branch. Every schema test runs inside
 * a transaction that is rolled back, so nothing persists. Never point this at production.
 */
export const TEST_DB_URL = process.env.TEST_DATABASE_URL;
export const hasTestDb = Boolean(TEST_DB_URL);

export async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: normalizeConnectionString(TEST_DB_URL as string) });
  await client.connect();
  return client;
}

/** Run fn inside BEGIN … ROLLBACK. */
export async function inRollback<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Expect a statement to fail with a SQLSTATE (or message fragment) without poisoning the surrounding transaction. */
export async function expectFails(client: pg.Client, sql: string, params: unknown[] = [], match?: string | RegExp) {
  await client.query('SAVEPOINT expect_fail');
  let error: unknown;
  try {
    await client.query(sql, params);
  } catch (e) {
    error = e;
  }
  await client.query('ROLLBACK TO expect_fail');
  if (!error) throw new Error(`expected failure but succeeded: ${sql}`);
  if (match) {
    const e = error as { code?: string; message?: string };
    const hay = `${e.code ?? ''} ${e.message ?? ''}`;
    if (typeof match === 'string' ? !hay.includes(match) : !match.test(hay))
      throw new Error(`failure "${hay}" did not match ${String(match)}`);
  }
}

export async function insertBrand(client: pg.Client, code = 'T1'): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    'INSERT INTO brand (legacy_id, code, name) VALUES ($1, $1, $1) RETURNING id',
    [code],
  );
  return rows[0]!.id;
}

export async function insertRecipe(client: pg.Client, brandId: string, code: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO recipe (code, name, category, type, brand_id) VALUES ($1, 'n', 'c', 'MENU', $2) RETURNING id`,
    [code, brandId],
  );
  return rows[0]!.id;
}

export async function insertIngredient(client: pg.Client, code: string, price: number | null = 1): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ingredient (code, name, uom, price, category, subcategory) VALUES ($1, 'n', 'Gram', $2, 'c', 's') RETURNING id`,
    [code, price],
  );
  return rows[0]!.id;
}
