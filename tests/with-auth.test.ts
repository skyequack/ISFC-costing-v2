import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSession() }));
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

import { withAuth, withPublic } from '@/lib/auth/with-auth';

const user = { id: 'u1', clerkUserId: 'c1', email: 'a@b.c', name: 'A', role: 'viewer' as const };
const req = () => new Request('http://x/api/t');
const noParams = { params: Promise.resolve({}) };
const ok = () => Response.json({ ok: true });

describe('withAuth', () => {
  beforeEach(() => getSession.mockReset());

  it('401 when anonymous', async () => {
    getSession.mockResolvedValue({ status: 'anonymous' });
    const res = await withAuth({}, ok)(req(), noParams);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
  });

  it('403 pending (not viewer) when no role', async () => {
    getSession.mockResolvedValue({ status: 'pending', clerkUserId: 'c1' });
    const res = await withAuth({}, ok)(req(), noParams);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('pending');
  });

  it('403 inactive', async () => {
    getSession.mockResolvedValue({ status: 'inactive', clerkUserId: 'c1' });
    const res = await withAuth({}, ok)(req(), noParams);
    expect((await res.json()).error.code).toBe('inactive');
  });

  it('403 when role lacks the permission; handler not called', async () => {
    getSession.mockResolvedValue({ status: 'ok', user });
    const h = vi.fn(ok);
    const res = await withAuth({ perm: 'recipe.edit' }, h)(req(), noParams);
    expect(res.status).toBe(403);
    expect(h).not.toHaveBeenCalled();
  });

  it('runs the handler with user, params and request id', async () => {
    getSession.mockResolvedValue({ status: 'ok', user });
    const res = await withAuth<{ id: string }>({ perm: 'export' }, (_r, c) =>
      Response.json({ id: c.params.id, u: c.user.id }),
    )(req(), { params: Promise.resolve({ id: '7' }) });
    expect(await res.json()).toEqual({ id: '7', u: 'u1' });
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('maps unexpected throws to a 500 without internals', async () => {
    getSession.mockResolvedValue({ status: 'ok', user });
    const res = await withAuth({}, () => {
      throw new Error('db password=hunter2');
    })(req(), noParams);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('hunter2');
  });
});

describe('withPublic', () => {
  it('wraps errors too', async () => {
    const res = await withPublic(() => {
      throw new Error('boom');
    })(req());
    expect(res.status).toBe(500);
  });
});
