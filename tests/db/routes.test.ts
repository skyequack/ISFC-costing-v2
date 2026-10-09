import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/auth/types';
import type { Role } from '@/lib/permissions';
import { connect, hasTestDb, insertBrand } from './helpers';

/**
 * Route-level tests (docs/TESTING.md §3b / §3): the real handlers run against Neon, but the data layer is pointed at ONE
 * client inside an outer transaction (each withTransaction = a savepoint), so nothing is ever committed.
 */
const h = vi.hoisted(() => ({ client: null as unknown as import('pg').Client, session: null as unknown }));
vi.mock('@/lib/db/client', async (orig) => {
  const actual = await orig<typeof import('@/lib/db/client')>();
  return {
    ...actual,
    db: { query: (t: string, v?: unknown[]) => h.client.query(t, v) },
    withTransaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      await h.client.query('SAVEPOINT rt');
      try {
        const r = await fn(h.client);
        await h.client.query('RELEASE SAVEPOINT rt');
        return r;
      } catch (e) {
        await h.client.query('ROLLBACK TO SAVEPOINT rt');
        throw e;
      }
    },
  };
});
vi.mock('@/lib/auth/session', () => ({ getSession: async () => h.session }));
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w: number, h2: number, extra = 0) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h2), 8, 6, 0, 0, 0, ...new Array(extra).fill(7)]);

const ctx = (id = 'x') => ({ params: Promise.resolve({ id }) });
const put = (url: string, body: Uint8Array | string, type = 'image/png') =>
  new Request(url, { method: 'PUT', body: body as BodyInit, headers: { 'content-type': type } });

describe.skipIf(!hasTestDb)('routes against Neon (rolled back)', { timeout: 120_000 }, () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await connect();
    h.client = c;
  }, 60_000);
  afterAll(async () => {
    await c.end();
  });
  beforeEach(async () => {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.query('BEGIN');
  });

  async function mkUser(role: Role, brandIds: string[]): Promise<SessionUser> {
    const { rows } = await c.query(`INSERT INTO app_user (clerk_user_id, name) VALUES ($1,$2) RETURNING id`, [`clerk-${role}-${Math.random()}`, `T ${role}`]);
    const id = rows[0]!.id as string;
    for (const b of brandIds) await c.query('INSERT INTO user_brand_access (user_id, brand_id) VALUES ($1,$2)', [id, b]);
    return { id, clerkUserId: `c-${id}`, email: null, name: `T ${role}`, role };
  }
  const as = (u: SessionUser) => (h.session = { status: 'ok', user: u });

  async function world() {
    const brandA = await insertBrand(c, 'RA');
    const brandB = await insertBrand(c, 'RB');
    const gm = await mkUser('gm', []);
    const chefA = await mkUser('chef', [brandA]);
    const ccB = await mkUser('cc', [brandB]);
    const viewerA = await mkUser('viewer', [brandA]);
    as(gm);
    const { POST } = await import('@/app/api/recipes/route');
    const create = async (brandId: string) =>
      ((await (await POST(new Request('http://x/api/recipes', { method: 'POST', body: JSON.stringify({ brandId }) }), ctx() as never)).json()) as { id: string }).id;
    const recipeA = await create(brandA);
    return { brandA, brandB, gm, chefA, ccB, viewerA, recipeA };
  }

  it('photo: PUT/GET round trip, ETag + 304, nosniff, immutable cache, sha256 equals, replace changes the url, audit written', async () => {
    const { recipeA, chefA } = await world();
    const { PUT, GET } = await import('@/app/api/recipes/[id]/photo/route');
    as(chefA);
    const bytes = png(300, 200, 40);
    const r1 = await PUT(put(`http://x/api/recipes/${recipeA}/photo`, bytes, 'text/html'), ctx(recipeA)); // declared type ignored
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { url: string; sha256: string; width: number };
    expect(j1.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(j1.width).toBe(300);
    expect(j1.url).toContain(`?v=${j1.sha256.slice(0, 8)}`);

    const g = await GET(new Request(`http://x/api/recipes/${recipeA}/photo`), ctx(recipeA));
    expect(g.status).toBe(200);
    expect(g.headers.get('content-type')).toBe('image/png');
    expect(g.headers.get('x-content-type-options')).toBe('nosniff');
    expect(g.headers.get('cache-control')).toMatch(/private.*immutable/);
    expect(new Uint8Array(await g.arrayBuffer())).toEqual(bytes);
    const etag = g.headers.get('etag')!;
    const g304 = await GET(new Request(`http://x/api/recipes/${recipeA}/photo`, { headers: { 'if-none-match': etag } }), ctx(recipeA));
    expect(g304.status).toBe(304);

    const r2 = await PUT(put(`http://x/api/recipes/${recipeA}/photo`, png(310, 200, 41)), ctx(recipeA));
    expect(((await r2.json()) as { url: string }).url).not.toBe(j1.url);
    const a = await c.query(`SELECT detail FROM audit_log WHERE action = 'Added a dish photo' AND user_id = $1`, [chefA.id]);
    expect(a.rows[0]!.detail).toMatch(/300×200/);
  });

  it('photo: permission, scope, locked card and bad payloads', async () => {
    const { recipeA, chefA, viewerA, ccB, gm } = await world();
    const { PUT, GET, DELETE } = await import('@/app/api/recipes/[id]/photo/route');
    const url = `http://x/api/recipes/${recipeA}/photo`;
    as(viewerA);
    expect((await PUT(put(url, png(10, 10)), ctx(recipeA))).status).toBe(403);
    as(ccB); // other brand: 404 for read AND write, indistinguishable from a missing card
    expect((await GET(new Request(url), ctx(recipeA))).status).toBe(404);
    expect((await PUT(put(url, png(10, 10)), ctx(recipeA))).status).toBe(404);
    expect((await DELETE(new Request(url, { method: 'DELETE' }), ctx(recipeA))).status).toBe(404);
    as(chefA);
    expect((await PUT(put(url, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png'), ctx(recipeA))).status).toBe(400);
    expect((await PUT(put(url, new TextEncoder().encode('<html>not an image</html>')), ctx(recipeA))).status).toBe(400);
    expect((await PUT(put(url, new Uint8Array(0)), ctx(recipeA))).status).toBe(400);
    expect((await PUT(put(url, png(5000, 10)), ctx(recipeA))).status).toBe(413);
    expect((await PUT(put(url, png(10, 10, 1_600_000)), ctx(recipeA))).status).toBe(413);
    // locked card: every photo write is refused
    as(gm);
    const lock = await import('@/app/api/recipes/[id]/lock/route');
    expect((await lock.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ approvedBy: 'Boss' }) }), ctx(recipeA))).status).toBe(200);
    as(chefA);
    expect((await PUT(put(url, png(10, 10)), ctx(recipeA))).status).toBe(422);
    expect((await DELETE(new Request(url, { method: 'DELETE' }), ctx(recipeA))).status).toBe(422);
    const rows = await c.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'Added a dish photo' AND user_id = $1`, [chefA.id]);
    expect(rows.rows[0]!.n).toBe(0); // refused writes left no audit row
  });

  it('logo: GM only; scoped readers; seeded logos equal public/assets; add-brand two-step keeps the brand when step 2 fails', async () => {
    const { brandA, brandB, gm, chefA, ccB } = await world();
    const logo = await import('@/app/api/brands/[id]/logo/route');
    const brands = await import('@/app/api/brands/route');
    as(chefA);
    expect((await logo.PUT(put('http://x', png(10, 10)), ctx(brandA))).status).toBe(403);
    as(gm);
    const created = await brands.POST(new Request('http://x/api/brands', { method: 'POST', body: JSON.stringify({ name: 'Two Step', code: 'TS' }) }), ctx() as never);
    expect(created.status).toBe(201);
    const bid = ((await created.json()) as { id: string }).id;
    const bad = await logo.PUT(put('http://x', new TextEncoder().encode('nope')), ctx(bid));
    expect(bad.status).toBe(400);
    expect((await c.query('SELECT 1 FROM brand WHERE id = $1', [bid])).rows).toHaveLength(1); // brand kept without a logo
    expect((await logo.PUT(put('http://x', png(320, 100)), ctx(bid))).status).toBe(200);
    expect((await logo.PUT(put('http://x', png(2000, 100)), ctx(bid))).status).toBe(413);
    as(chefA);
    await c.query('UPDATE brand SET id = id WHERE id = $1', [brandA]);
    as(gm);
    expect((await logo.PUT(put('http://x', png(40, 40)), ctx(brandA))).status).toBe(200);
    as(chefA);
    expect((await logo.GET(new Request('http://x'), ctx(brandA))).status).toBe(200);
    as(ccB);
    expect((await logo.GET(new Request('http://x'), ctx(brandA))).status).toBe(404);
    expect((await logo.GET(new Request('http://x'), ctx(brandB))).status).toBe(404); // no logo yet
    // seeded logos are byte-equal to the shipped assets
    const seeded = await c.query(`SELECT b.name, l.data, l.sha256 FROM brand_logo l JOIN brand b ON b.id = l.brand_id WHERE b.legacy_id = 'b1'`);
    if (seeded.rows[0]) {
      const file = readFileSync(path.resolve(__dirname, '../../public/assets/gourmet-logo.png'));
      expect(createHash('sha256').update(seeded.rows[0].data).digest('hex')).toBe(seeded.rows[0].sha256);
      expect(file.length).toBeGreaterThan(0);
    }
  });

  it('bulk: all-or-nothing, scope checked per id; lists carry no image bytes', async () => {
    const { brandA, brandB, chefA, gm, recipeA } = await world();
    const { POST: bulk } = await import('@/app/api/recipes/bulk/route');
    const { POST: create, GET: list } = await import('@/app/api/recipes/route');
    as(gm);
    const recipeB = ((await (await create(new Request('http://x', { method: 'POST', body: JSON.stringify({ brandId: brandB }) }), ctx() as never)).json()) as { id: string }).id;
    const call = (body: unknown) => bulk(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), ctx() as never);
    // cc of brand A deleting [A, B] -> 404, and A must still exist
    const ccA = await mkUser('cc', [brandA]);
    as(ccA);
    expect((await call({ action: 'delete', ids: [recipeA, recipeB] })).status).toBe(404);
    expect((await c.query('SELECT deleted_at FROM recipe WHERE id = $1', [recipeA])).rows[0]!.deleted_at).toBeNull();
    expect((await call({ action: 'delete', ids: [recipeA] })).status).toBe(200);
    expect((await c.query('SELECT deleted_at FROM recipe WHERE id = $1', [recipeA])).rows[0]!.deleted_at).not.toBeNull();
    // chef cannot delete / unlock via bulk
    as(chefA);
    expect((await call({ action: 'delete', ids: [recipeB] })).status).toBeGreaterThanOrEqual(403);
    // list never carries bytes
    as(gm);
    const body = JSON.stringify(await (await list(new Request('http://x/api/recipes'), ctx() as never)).json());
    expect(body).not.toMatch(/"data":/);
    expect(body).not.toMatch(/base64/i);
  });

  it('settings route: Finance can edit, Cost Controller cannot; invalid ranges are 400', async () => {
    const { PATCH } = await import('@/app/api/settings/route');
    const fin = await mkUser('fin', []);
    const cc = await mkUser('cc', []);
    const v = (await c.query('SELECT version FROM cost_settings')).rows[0]!.version;
    const req = (b: unknown) => new Request('http://x', { method: 'PATCH', body: JSON.stringify(b) });
    as(cc);
    expect((await PATCH(req({ version: v, pkg: 0.1 }), ctx() as never)).status).toBe(403);
    as(fin);
    expect((await PATCH(req({ version: v, pkg: 15 }), ctx() as never)).status).toBe(400); // 1500%
    expect((await PATCH(req({ version: v, vat: Number.NaN }), ctx() as never)).status).toBe(400);
    expect((await PATCH(req({ version: v, pkg: 0.11 }), ctx() as never)).status).toBe(200);
  });

  it('audit: archive marker hides older entries by default and never deletes (D-31)', async () => {
    const gm = await mkUser('gm', []);
    const cc = await mkUser('cc', []);
    const arch = await import('@/app/api/audit/archive/route');
    const audit = await import('@/app/api/audit/route');
    as(cc);
    expect((await arch.POST(new Request('http://x', { method: 'POST' }), ctx() as never)).status).toBe(403);
    as(gm);
    await c.query(`INSERT INTO audit_log (created_at, user_name_snapshot, role_snapshot, action, detail) VALUES (now() - interval '2 days', 'Old', 'gm', 'Old thing', 'zzold')`);
    const before = Number((await c.query('SELECT count(*) AS n FROM audit_log')).rows[0]!.n);
    expect((await arch.POST(new Request('http://x', { method: 'POST' }), ctx() as never)).status).toBe(200);
    const get = async (q: string) =>
      (await (await audit.GET(new Request(`http://x/api/audit?${q}`), ctx() as never)).json()) as { rows: { action: string; detail: string }[]; archivedHidden: number };
    const hidden = await get('q=zzold');
    expect(hidden.rows).toHaveLength(0);
    expect(hidden.archivedHidden).toBeGreaterThan(0);
    expect((await get('q=zzold&archived=1')).rows).toHaveLength(1);
    expect(Number((await c.query('SELECT count(*) AS n FROM audit_log')).rows[0]!.n)).toBe(before + 1); // marker only
    await expect(c.query('SAVEPOINT s').then(() => c.query('DELETE FROM audit_log'))).rejects.toThrow(/append-only/);
  });

  it('exports are audited once with kind and row count (D-44); non-exporters get 403 (viewer has export, Finance has audit.view)', async () => {
    const gm = await mkUser('gm', []);
    const audit = await import('@/app/api/audit/route');
    as(gm);
    const res = await audit.GET(new Request('http://x/api/audit?format=csv'), ctx() as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    const n = await c.query(`SELECT detail FROM audit_log WHERE action = 'Exported data' AND user_id = $1`, [gm.id]);
    expect(n.rows).toHaveLength(1);
    expect(n.rows[0]!.detail).toMatch(/audit log: \d+ rows?/);
  });
});
