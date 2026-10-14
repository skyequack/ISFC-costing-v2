import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const apiDir = path.resolve(__dirname, '../src/app/api');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? routeFiles(p) : e.name === 'route.ts' ? [p] : [];
  });
}

describe('every API route is wrapped (deny by default)', () => {
  const files = routeFiles(apiDir);
  it('finds routes', () => expect(files.length).toBeGreaterThan(0));

  it.each(files.map((f) => [path.relative(apiDir, f), f] as const))('%s', (_rel, file) => {
    const src = fs.readFileSync(file, 'utf8');
    const exported = [...src.matchAll(/export\s+(?:const|async function|function)\s+(\w+)/g)].map((m) => m[1]!);
    const handlers = exported.filter((n) => METHODS.includes(n));
    expect(handlers.length).toBeGreaterThan(0);
    for (const h of handlers) {
      expect(src, `${h} must be created with withAuth( or withPublic(`).toMatch(
        new RegExp(`export\\s+const\\s+${h}\\s*=\\s*(withAuth|withPublic)\\b`),
      );
    }
  });

  it('only the allow-listed routes are public', () => {
    const publicRoutes = files
      .filter((f) => /withPublic\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(apiDir, f).replace(/\\/g, '/'));
    expect(publicRoutes).toEqual(['health/route.ts']);
  });
});

describe('rate limits are declared on exactly the intended handlers (D-87, D-88)', () => {
  /** `METHOD route` -> class. Reads, saves, bulk and search are deliberately absent: they are never limited. */
  const EXPECTED: Record<string, string> = {
    'GET export/backup': 'export_backup',
    'GET export/[kind]': 'export_kind',
    'POST import/restore/chunk': 'restore_chunk',
    'POST import/restore': 'restore',
    'POST stock/import': 'import',
    'POST ingredients/import': 'import',
    'POST recipes/import': 'import',
    'POST recipes/[id]/revisions': 'revision',
    'PUT recipes/[id]/photo': 'upload',
    'DELETE recipes/[id]/photo': 'upload',
    'PUT brands/[id]/logo': 'upload',
    'DELETE brands/[id]/logo': 'upload',
    'POST users/invite': 'user_admin',
    'PATCH users/invites/[id]': 'user_admin',
    'DELETE users/invites/[id]': 'user_admin',
    'PATCH users/[id]': 'user_admin',
    'DELETE users/[id]': 'user_admin',
    'POST users/[id]/ban': 'user_admin',
    'POST users/[id]/unban': 'user_admin',
    'POST brands': 'admin_write',
    'PATCH brands/[id]': 'admin_write',
    'DELETE brands/[id]': 'admin_write',
    'POST audit/archive': 'admin_write',
    'POST units': 'admin_write',
    'DELETE units/[code]': 'admin_write',
  };

  function declared(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const file of routeFiles(apiDir)) {
      const route = path.relative(apiDir, path.dirname(file)).split(path.sep).join('/');
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/export\s+const\s+(\w+)\s*=\s*withAuth(?:<[^>]*>)?\(\s*\{([^}]*)\}/g)) {
        const cls = /limit:\s*'(\w+)'/.exec(m[2]!)?.[1];
        if (cls) out[`${m[1]} ${route}`] = cls;
      }
    }
    return out;
  }

  it('the limited handlers and their classes are exactly the approved list (nothing added or dropped by accident)', () => {
    const sort = (o: Record<string, string>) =>
      Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    expect(sort(declared())).toEqual(sort(EXPECTED));
  });

  it('every class in the budget table is used by at least one route', async () => {
    const { RATE_RULES } = await import('@/lib/rate-limit/budgets');
    expect(new Set(Object.values(declared()))).toEqual(new Set(Object.keys(RATE_RULES)));
  });

  it('the limit sits next to a permission, so it is counted only for callers who passed that check', () => {
    for (const file of routeFiles(apiDir)) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/withAuth(?:<[^>]*>)?\(\s*\{([^}]*limit:[^}]*)\}/g))
        expect(m[1], file).toMatch(/perm:/);
    }
  });
});
