// Loads db/seed-data into the database named by DATABASE_URL_UNPOOLED (single transaction, idempotent).
//   npm run db:seed                 seed (no-op if already seeded with identical inputs)
//   npm run db:seed -- --confirm    required when NEON_BRANCH is 'production' (or unset-but-not-dev)
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['.env.local', '.env']) {
  if (existsSync(join(root, f))) process.loadEnvFile(join(root, f));
}

const url = process.env.DATABASE_URL_UNPOOLED;
if (!url) {
  console.error('DATABASE_URL_UNPOOLED is not set.');
  process.exit(1);
}
if (/-pooler\./.test(url)) {
  console.error('DATABASE_URL_UNPOOLED points at the pooler; seeding needs the direct connection.');
  process.exit(1);
}
const branch = process.env.NEON_BRANCH ?? '(unknown)';
if (branch !== 'dev' && !process.argv.includes('--confirm')) {
  console.error(`Target branch is "${branch}", not "dev". Re-run with --confirm if this is intended.`);
  process.exit(1);
}

const conn = new URL(url);
if (['require', 'prefer', 'verify-ca'].includes(conn.searchParams.get('sslmode') ?? ''))
  conn.searchParams.set('sslmode', 'verify-full');

const { readSeedInputs, seedDatabase } = await import('../src/lib/seed/seed.ts');
const client = new pg.Client({ connectionString: conn.toString() });
await client.connect();
try {
  console.log(`seeding branch: ${branch}`);
  const result = await seedDatabase(client, readSeedInputs(root));
  console.log(result.status, result.checksum.slice(0, 12));
  console.table(result.counts);
} finally {
  await client.end();
}
