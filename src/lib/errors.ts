/** Error format: {error:{code,message,details?,requestId}} (docs/ARCHITECTURE.md §2). */
export type ErrorCode =
  | 'bad_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'pending'
  | 'inactive'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'unprocessable'
  | 'rate_limited'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  pending: 403,
  inactive: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  unprocessable: 422,
  rate_limited: 429,
  internal: 500,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    /** seconds, for `rate_limited`: sent as the Retry-After header (D-87) */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = STATUS[code];
  }
}

export function errorResponse(err: unknown, requestId: string): Response {
  const e = err instanceof ApiError ? err : new ApiError('internal', 'Internal error'); // no internals leaked
  const body = {
    error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}), requestId },
  };
  const headers: Record<string, string> = { 'x-request-id': requestId };
  if (e.retryAfter !== undefined) headers['retry-after'] = String(e.retryAfter);
  return Response.json(body, { status: e.status, headers });
}
