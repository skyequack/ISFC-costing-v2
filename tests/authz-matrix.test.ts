import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/errors';
import { can, ROLE_KEYS, type Permission, type Role } from '@/lib/permissions';

/**
 * Phase 4 gate (docs/TESTING.md §3): 6 roles x every endpoint that declares a permission in withAuth({perm}).
 * Expected result is derived from ROLES (+ menu.edit; users.manage / data.admin / brands.edit are GM-only via '*'):
 * a role without the permission gets 403 and the handler body never runs; a role with it gets past the gate
 * (anything but 403 - here the mocked data layer answers 404). Endpoints whose rules live in the service
 * (field-level recipe PATCH, ingredient scope, etc.) are covered by tests/db/services.test.ts.
 */
const getSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSession() }));
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('@/lib/api', () => {
  const reached = () => {
    throw new ApiError('not_found', 'handler reached');
  };
  return { inTx: reached, withScope: reached, bustCatalog: vi.fn(), noStore: {} };
});
vi.mock('@/lib/auth/clerk-port', () => ({ clerkPort: () => ({}) }));
vi.mock('@/lib/db/client', () => ({ db: { query: vi.fn() }, withTransaction: vi.fn() }));
vi.mock('@/lib/db/catalog-cache', () => ({ getCatalog: vi.fn(), CATALOG_TAG: 'catalog' }));

const apiDir = path.resolve(__dirname, '../src/app/api');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? routeFiles(p) : e.name === 'route.ts' ? [p] : [];
  });
}

interface Endpoint {
  file: string;
  method: string;
  perm: Permission | null;
  url: string;
}

function endpoints(): Endpoint[] {
  const out: Endpoint[] = [];
  for (const file of routeFiles(apiDir)) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(apiDir, path.dirname(file)).replace(/\\/g, '/');
    const url = 'http://x/api/' + rel.replace(/\[(\w+)\]/g, 'abc') ;
    for (const m of METHODS) {
      const re = new RegExp(`export\\s+const\\s+${m}\\s*=\\s*withAuth(?:<[^>]*>)?\\(\\s*\\{([^}]*)\\}`);
      const match = src.match(re);
      if (!match) continue;
      const perm = match[1]!.match(/perm:\s*'([\w.]+)'/)?.[1] as Permission | undefined;
      out.push({ file, method: m, perm: perm ?? null, url });
    }
  }
  return out;
}

const user = (role: Role) => ({ id: `u-${role}`, clerkUserId: `c-${role}`, email: null, name: role, role });
const gated = endpoints().filter((e) => e.perm !== null);

describe('permission matrix', () => {
  beforeEach(() => getSession.mockReset());

  it('finds the permission-gated endpoints', () => {
    expect(gated.length).toBeGreaterThanOrEqual(30);
    // the GM-only permissions are used by their endpoints
    for (const p of ['users.manage', 'data.admin', 'brands.edit', 'menu.edit'] as const)
      expect(gated.some((e) => e.perm === p), p).toBe(true);
  });

  it('GM-only permissions are held by no other role', () => {
    for (const p of ['users.manage', 'data.admin', 'brands.edit'] as const)
      for (const r of ROLE_KEYS) expect(can(r, p), `${r} ${p}`).toBe(r === 'gm');
    expect(ROLE_KEYS.filter((r) => can(r, 'menu.edit')).sort()).toEqual(['cc', 'gm']);
  });

  const cases = gated.flatMap((e) => ROLE_KEYS.map((r) => [`${r} ${e.method} ${path.relative(apiDir, path.dirname(e.file)).replace(/\\/g, '/')}`, e, r] as const));

  it.each(cases)('%s', async (_name, e, role) => {
    getSession.mockResolvedValue({ status: 'ok', user: user(role) });
    const mod = (await import(/* @vite-ignore */ e.file)) as Record<string, (req: Request, ctx: unknown) => Promise<Response>>;
    const body = e.method === 'GET' || e.method === 'DELETE' ? undefined : JSON.stringify({});
    const res = await mod[e.method]!(new Request(e.url, { method: e.method, body, headers: { 'content-type': 'application/json' } }), {
      params: Promise.resolve({ id: 'abc' }),
    });
    const allowed = can(role, e.perm!);
    if (allowed) expect(res.status, 'must pass the permission gate').not.toBe(403);
    else expect(res.status).toBe(403);
  });
});

describe('every non-gated handler is still wrapped (deny by default)', () => {
  it('lists the service-gated endpoints so a new one cannot slip by silently', () => {
    const open = endpoints()
      .filter((e) => e.perm === null)
      .map((e) => `${e.method} ${path.relative(apiDir, path.dirname(e.file)).replace(/\\/g, '/')}`)
      .sort();
    // endpoints that authorise inside the service (field-level or scoped rules); anything new must be added knowingly
    const allowed = new Set([
      'GET recipes', 'GET recipes/[id]', 'PATCH recipes/[id]', 'DELETE recipes/[id]', 'GET recipes/[id]/photo',
      'POST recipes/bulk', 'GET ingredients', 'GET brands', 'GET settings', 'GET me', 'GET catalog/search', 'GET menus',
      'GET brands/[id]/logo',
    ]);
    for (const o of open) expect(allowed.has(o), `${o} has no declared permission - add it to withAuth or allow-list it`).toBe(true);
  });
});
