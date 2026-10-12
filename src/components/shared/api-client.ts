'use client';

import { RATE_WAIT_EVENT, tooManyText } from './rate-limit-text';

export class ClientApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
    readonly code?: string,
    /** seconds, from Retry-After, on a 429 (D-87) */
    readonly retryAfter?: number,
    /** the URL that was refused, so the wording can tell account changes from other requests */
    readonly url?: string,
  ) {
    super(message);
  }
}

/** The longest wait the browser sits through by itself before it tries once more (D-90). Longer: tell the user instead. */
export const AUTO_RETRY_MAX_SECONDS = 15;
/** Invites, role changes and bans are never retried by themselves: a second email or change must be the user's choice. */
const NEVER_RETRY = ['/api/users'];

export interface RetryOptions {
  /** called when the one automatic retry starts waiting; without it the window event RATE_WAIT_EVENT is sent instead */
  onWait?: (seconds: number) => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryAfterOf(res: Response): number | undefined {
  const v = Number(res.headers.get('retry-after'));
  return Number.isFinite(v) && v > 0 ? Math.ceil(v) : undefined;
}

/**
 * fetch with ONE automatic retry when the server says 429 and the wait is short (D-90). Safe because the server refuses
 * before the handler runs (D-87), so a refused request never had a side effect. Request bodies here are strings or Blobs,
 * so they can be sent again. Any other answer, a second 429 or a long wait is returned for the caller to show.
 */
export async function fetchRetry(url: string, init?: RequestInit, opts: RetryOptions = {}): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 429 || NEVER_RETRY.some((p) => url.startsWith(p))) return res;
  const wait = retryAfterOf(res);
  if (wait === undefined || wait > AUTO_RETRY_MAX_SECONDS) return res;
  if (opts.onWait) opts.onWait(wait);
  else if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent(RATE_WAIT_EVENT, { detail: { seconds: wait } }));
  await sleep(wait * 1000);
  return fetch(url, init);
}

/** The error for a failed response: the server's message, or the plain "too many tries" wording for a 429. */
export async function apiErrorOf(
  res: Response,
  url: string,
  fallback: (status: number) => string,
): Promise<ClientApiError> {
  const text = await res.text().catch(() => '');
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  const retryAfter = res.status === 429 ? retryAfterOf(res) : undefined;
  return new ClientApiError(res.status, e?.message ?? fallback(res.status), e?.details, e?.code, retryAfter, url);
}

/** JSON fetch helper for the screens. Errors carry the server's message (shown in a toast, like legacy toast()). */
export async function api<T = unknown>(method: string, url: string, body?: unknown, opts?: RetryOptions): Promise<T> {
  const res = await fetchRetry(
    url,
    {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    },
    opts,
  );
  if (!res.ok) throw await apiErrorOf(res, url, (s) => `Request failed (${s})`);
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : null) as T;
  } catch {
    return null as T; // non-JSON body
  }
}

/** True for a request the server refused because of the rate limit. */
export const isRateLimited = (e: unknown): e is ClientApiError => e instanceof ClientApiError && e.status === 429;

export function errText(e: unknown): string {
  if (isRateLimited(e)) return tooManyText(e.retryAfter, Boolean(e.url?.startsWith('/api/users')));
  return e instanceof Error ? e.message : 'Something went wrong';
}

/** PUT raw image bytes (D-49: no base64, no multipart). Returns the DTO url + metadata. */
export async function uploadImage(
  url: string,
  blob: Blob,
): Promise<{ url: string; sha256: string; size: number; width: number; height: number }> {
  const res = await fetchRetry(url, {
    method: 'PUT',
    headers: { 'content-type': blob.type || 'application/octet-stream' },
    body: blob,
    cache: 'no-store',
  });
  if (!res.ok) throw await apiErrorOf(res, url, (s) => `Upload failed (${s})`);
  return (await res.json()) as never;
}
