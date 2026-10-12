import { ApiError, errorResponse } from '../errors';
import { withSqlStats, type SqlStats } from '../db/trace';
import { log } from '../logger';
import { can, type Permission } from '../permissions';
import { enforceRateLimit, type RateClass } from '../rate-limit';
import { getSession } from './session';
import type { SessionUser } from './types';

export interface AuthContext<P = Record<string, string>> {
  user: SessionUser;
  params: P;
  requestId: string;
}

interface RouteCtx<P> {
  params: Promise<P>;
}

type AuthHandler<P> = (req: Request, ctx: AuthContext<P>) => Promise<Response> | Response;

function finish(
  req: Request,
  requestId: string,
  start: number,
  res: Response,
  clerkUserId: string | null,
  sql?: SqlStats,
  limit?: RateClass,
): Response {
  log('info', 'request', {
    reqId: requestId,
    clerkUserId,
    route: `${req.method} ${new URL(req.url).pathname}`,
    status: res.status,
    ms: Date.now() - start,
    ...(res.status === 429 && limit ? { rl: { cls: limit, retryAfter: Number(res.headers.get('retry-after')) } } : {}),
    ...(sql ? { sql: sql.n, sqlMs: Math.round(sql.ms), ...(sql.q ? { q: sql.q } : {}) } : {}),
  });
  return res;
}

/**
 * Wraps EVERY API route handler (a meta-test enforces it). Order: session → active/role → permission → rate limit → handler.
 * `limit` (D-87, D-88) names the route's rate-limit class; the check runs after the permission check, so a 401/403 is never
 * counted or replaced by a 429, and before the handler, so a refused request has no side effect.
 * Errors are mapped to {error:{code,message,details?,requestId}}; unexpected errors never leak internals.
 */
export function withAuth<P = Record<string, string>>(
  opts: { perm?: Permission; limit?: RateClass },
  handler: AuthHandler<P>,
) {
  return async (req: Request, routeCtx: RouteCtx<P>): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const start = Date.now();
    let clerkUserId: string | null = null;
    const { out, stats } = await withSqlStats(async () => {
      try {
        const s = await getSession();
        if (s.status === 'anonymous') throw new ApiError('unauthenticated', 'Sign in required');
        clerkUserId = s.status === 'ok' ? s.user.clerkUserId : s.clerkUserId;
        if (s.status === 'inactive') throw new ApiError('inactive', 'This account is suspended');
        if (s.status === 'pending') throw new ApiError('pending', 'Your account is pending role assignment');
        if (opts.perm && !can(s.user.role, opts.perm)) throw new ApiError('forbidden', 'Your role cannot do that');
        const params = (routeCtx?.params ? await routeCtx.params : {}) as P;
        if (opts.limit) await enforceRateLimit(s.user.clerkUserId, opts.limit);
        const res = await handler(req, { user: s.user, params, requestId });
        res.headers.set('x-request-id', requestId);
        return res;
      } catch (err) {
        if (!(err instanceof ApiError))
          log('error', 'unhandled', { reqId: requestId, err: err instanceof Error ? err.message : 'unknown' });
        return errorResponse(err, requestId);
      }
    });
    return finish(req, requestId, start, out, clerkUserId, stats, opts.limit);
  };
}

/** For the few intentionally public routes (e.g. /api/health). Listed explicitly so the meta-test can allow them. */
export function withPublic(handler: (req: Request, requestId: string) => Promise<Response> | Response) {
  return async (req: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const start = Date.now();
    try {
      const res = await handler(req, requestId);
      res.headers.set('x-request-id', requestId);
      return finish(req, requestId, start, res, null);
    } catch (err) {
      if (!(err instanceof ApiError))
        log('error', 'unhandled', { reqId: requestId, err: err instanceof Error ? err.message : 'unknown' });
      return finish(req, requestId, start, errorResponse(err, requestId), null);
    }
  };
}
