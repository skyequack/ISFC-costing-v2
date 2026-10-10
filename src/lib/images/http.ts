import { ApiError } from '../errors';
import { IMAGE_LIMITS, type ImageKind } from './sniff';
import type { StoredImage } from './store';

/** Read the raw request body with the kind's byte cap enforced before and after buffering (D-49). */
export async function readImageBody(req: Request, kind: ImageKind): Promise<Uint8Array> {
  const { maxBytes } = IMAGE_LIMITS[kind];
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new ApiError('too_large', `The image is over ${Math.round(maxBytes / 1000)} KB`);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > maxBytes) throw new ApiError('too_large', `The image is over ${Math.round(maxBytes / 1000)} KB`);
  return buf;
}

/** Authenticated image response: ETag = sha256, immutable private cache (the DTO url carries ?v=<sha8>), nosniff. */
export function imageResponse(req: Request, img: StoredImage): Response {
  const etag = `"${img.sha256}"`;
  const headers = {
    etag,
    'content-type': img.contentType,
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  };
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(img.data), {
    status: 200,
    headers: { ...headers, 'content-length': String(img.data.length) },
  });
}
