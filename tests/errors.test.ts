import { describe, expect, it } from 'vitest';
import { ApiError, errorResponse } from '@/lib/errors';

describe('error format', () => {
  it('maps ApiError to {error:{code,message,details?,requestId}}', async () => {
    const res = errorResponse(new ApiError('conflict', 'Version mismatch', { expected: 2 }), 'rid-1');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: 'conflict', message: 'Version mismatch', details: { expected: 2 }, requestId: 'rid-1' },
    });
  });

  it('never leaks internals of unexpected errors', async () => {
    const res = errorResponse(new Error('connection string postgres://secret'), 'rid-2');
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('secret');
    expect(text).toContain('rid-2');
  });

  it.each([
    ['unauthenticated', 401],
    ['forbidden', 403],
    ['pending', 403],
    ['inactive', 403],
    ['not_found', 404],
    ['too_large', 413],
    ['unprocessable', 422],
    ['rate_limited', 429],
    ['bad_request', 400],
  ] as const)('%s -> %i', (code, status) => expect(new ApiError(code, 'x').status).toBe(status));
});
