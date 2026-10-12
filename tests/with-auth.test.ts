import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getSession: () => getSession() }));
vi.mock('@/lib/logger', () => ({ log: vi.fn() }));
const enforce = vi.fn();
vi.mock('@/lib/rate-limit', () => ({ enforceRateLimit: (...a: unknown[]) => enforce(...a) }));

import { withAuth, withPublic } from '@/lib/auth/with-auth';
import { ApiError } from '@/lib/errors';

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

describe('withAuth rate limit (D-87)', () => {
  beforeEach(() => {
    getSession.mockReset();
    enforce.mockReset();
  });

  it('a route without `limit` never touches the limiter', async () => {
    getSession.mockResolvedValue({ status: 'ok', user });
    const res = await withAuth({ perm: 'export' }, ok)(req(), noParams);
    expect(res.status).toBe(200);
    expect(enforce).not.toHaveBeenCalled();
  });

  it('counts the user (Clerk id) in the declared class, after the permission check, then runs the handler', async () => {
    getSession.mockResolvedValue({ status: 'ok', user });
    enforce.mockResolvedValue(undefined);
    const h = vi.fn(ok);
    const res = await withAuth({ perm: 'export', limit: 'export_kind' }, h)(req(), noParams);
    expect(res.status).toBe(200);
    expect(enforce).toHaveBeenCalledWith('c1', 'export_kind');
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('over budget: 429, code rate_limited, numeric Retry-After, request id, and the handler is never called', async () => {
    getSession.mockResolvedValue({ status: 'ok', user });
    enforce.mockRejectedValue(new ApiError('rate_limited', 'Too many requests. Try again shortly.', undefined, 37));
    const h = vi.fn(ok);
    const res = await withAuth({ perm: 'export', limit: 'export_kind' }, h)(req(), noParams);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('37');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const body = await res.json();
    expect(body.error.code).toBe('rate_limited');
    expect(JSON.stringify(body)).not.toMatch(/budget|window|\b37\b/); // nothing about the limit leaks
    expect(h).not.toHaveBeenCalled();
  });

  it('anonymous, inactive, pending and forbidden requests are never counted (and keep their own status)', async () => {
    for (const [session, wantStatus] of [
      [{ status: 'anonymous' }, 401],
      [{ status: 'inactive', clerkUserId: 'c1' }, 403],
      [{ status: 'pending', clerkUserId: 'c1' }, 403],
      [{ status: 'ok', user }, 403], // viewer lacks recipe.edit
    ] as const) {
      getSession.mockResolvedValue(session);
      const res = await withAuth({ perm: 'recipe.edit', limit: 'import' }, ok)(req(), noParams);
      expect(res.status).toBe(wantStatus);
    }
    expect(enforce).not.toHaveBeenCalled();
  });

  it('a handler that fails after the count still leaves the count in place (it is not rolled back with the request)', async () => {
    getSession.mockResolvedValue({ status: 'ok', user });
    enforce.mockResolvedValue(undefined);
    const res = await withAuth({ limit: 'upload' }, () => {
      throw new ApiError('bad_request', 'nope');
    })(req(), noParams);
    expect(res.status).toBe(400);
    expect(enforce).toHaveBeenCalledTimes(1);
  });
});
