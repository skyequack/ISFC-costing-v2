import { z } from 'zod';
import { ApiError } from './errors';

/** Parse + validate a JSON body. Any failure is a 400 naming the offending paths (never the values). */
export async function parseJson<T extends z.ZodType>(req: Request, schema: T, maxBytes = 2_000_000): Promise<z.output<T>> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new ApiError('too_large', 'Request body is too large');
  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > maxBytes) throw new ApiError('too_large', 'Request body is too large');
    raw = text ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError('bad_request', 'Body must be valid JSON');
  }
  return parseValue(raw, schema);
}

export function parseValue<T extends z.ZodType>(raw: unknown, schema: T): z.output<T> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const fields = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new ApiError('bad_request', 'Invalid request', { fields });
  }
  return r.data;
}

export function parseQuery<T extends z.ZodType>(req: Request, schema: T): z.output<T> {
  const o: Record<string, string> = {};
  new URL(req.url).searchParams.forEach((v, k) => (o[k] = v));
  return parseValue(o, schema);
}

/** A finite number (rejects NaN/Infinity — D-36). */
export const fin = () => z.number().finite();
