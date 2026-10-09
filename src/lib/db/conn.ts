/**
 * node-postgres treats sslmode=require/prefer/verify-ca as verify-full today and warns that this
 * will change to libpq semantics (no certificate verification). Neon's certificates are publicly
 * trusted, so we say verify-full explicitly: same security as today, no warning, no surprise
 * when pg changes the default. (scripts/migrate.mjs carries the same 5-line rule.)
 */
export function normalizeConnectionString(url: string): string {
  const u = new URL(url);
  const mode = u.searchParams.get('sslmode');
  if (mode === 'require' || mode === 'prefer' || mode === 'verify-ca') u.searchParams.set('sslmode', 'verify-full');
  return u.toString();
}
