// Applies db/migrations/*.sql in filename order over the UNPOOLED Neon connection.
//   npm run db:migrate            apply pending migrations (each in its own transaction)
//   npm run db:status             list applied / pending, verify checksums
// Forward-only. A migration that was already applied must never change (checksum check).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['.env.local', '.env']) {
  if (existsSync(join(root, f))) process.loadEnvFile(join(root, f)); // existing env vars are not overridden
}

const url = process.env.DATABASE_URL_UNPOOLED;
if (!url) {
  console.error('DATABASE_URL_UNPOOLED is not set (run `neon env pull` or `neon deploy`).');
  process.exit(1);
}
if (/-pooler\./.test(url)) {
  console.error('DATABASE_URL_UNPOOLED points at the pooler; migrations need the direct connection.');
  process.exit(1);
}

const statusOnly = process.argv.includes('--status');
const dir = join(root, 'db', 'migrations');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const sha = (s) => createHash('sha256').update(s).digest('hex');

// Same rule as src/lib/db/conn.ts: say verify-full explicitly (what pg does today for 'require') to avoid its warning.
const conn = new URL(url);
if (['require', 'prefer', 'verify-ca'].includes(conn.searchParams.get('sslmode') ?? ''))
  conn.searchParams.set('sslmode', 'verify-full');

const client = new pg.Client({ connectionString: conn.toString() });
await client.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Map(
    (await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]),
  );

  let pending = 0;
  for (const name of files) {
    const sql = readFileSync(join(dir, name), 'utf8').replaceAll('\r\n', '\n'); // EOL-independent checksum
    const checksum = sha(sql);
    if (applied.has(name)) {
      if (applied.get(name) !== checksum)
        throw new Error(`${name} was modified after it was applied (checksum mismatch)`);
      console.log(`applied  ${name}`);
      continue;
    }
    pending++;
    if (statusOnly) {
      console.log(`pending  ${name}`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
      await client.query('COMMIT');
      console.log(`applied  ${name} (now)`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`${name} failed: ${e.message}`);
    }
  }
  if (!pending) console.log('database is up to date');
} finally {
  await client.end();
}
