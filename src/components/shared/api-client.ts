'use client';

export class ClientApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** JSON fetch helper for the screens. Errors carry the server's message (shown in a toast, like legacy toast()). */
export async function api<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const e = (data as { error?: { message?: string; details?: unknown } } | null)?.error;
    throw new ClientApiError(res.status, e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}

export const errText = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong');

/** PUT raw image bytes (D-49: no base64, no multipart). Returns the DTO url + metadata. */
export async function uploadImage(
  url: string,
  blob: Blob,
): Promise<{ url: string; sha256: string; size: number; width: number; height: number }> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': blob.type || 'application/octet-stream' },
    body: blob,
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) throw new ClientApiError(res.status, data?.error?.message ?? `Upload failed (${res.status})`);
  return data as never;
}
