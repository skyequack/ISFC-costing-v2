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
