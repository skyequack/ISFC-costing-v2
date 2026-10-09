/**
 * Server-side image validation (D-49). The declared content-type / file extension is NEVER trusted:
 * the type and dimensions come from magic bytes. Only PNG, JPEG and WebP are accepted — SVG (script
 * capable) and everything else is rejected; the browser rasterises SVG logos to PNG before upload.
 */
import { createHash } from 'node:crypto';
import { ApiError } from '../errors';

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';
export type ImageKind = 'photo' | 'logo';

export interface ImageMeta {
  contentType: ImageType;
  width: number;
  height: number;
}

export interface ValidatedImage extends ImageMeta {
  size: number;
  sha256: string;
}

/** Caps mirror the DB CHECK constraints (schema.md). */
export const IMAGE_LIMITS: Record<ImageKind, { maxBytes: number; maxDim: number }> = {
  photo: { maxBytes: 1_500_000, maxDim: 4096 },
  logo: { maxBytes: 512_000, maxDim: 1024 },
};

const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u16le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

function sniffPng(b: Uint8Array): ImageMeta | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !sig.every((v, i) => b[i] === v)) return null;
  if (u32be(b, 8) !== 13 || ascii(b, 12, 4) !== 'IHDR') return null;
  return { contentType: 'image/png', width: u32be(b, 16), height: u32be(b, 20) };
}

function sniffJpeg(b: Uint8Array): ImageMeta | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    let marker = b[o + 1]!;
    while (marker === 0xff && o + 2 < b.length) {
      o++;
      marker = b[o + 1]!;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2; // standalone markers carry no length
      continue;
    }
    const len = u16be(b, o + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (o + 9 > b.length) return null;
      return { contentType: 'image/jpeg', height: u16be(b, o + 5), width: u16be(b, o + 7) };
    }
    if (marker === 0xda) return null; // start of scan reached without a frame header
    o += 2 + len;
  }
  return null;
}

function sniffWebp(b: Uint8Array): ImageMeta | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return null;
  const fourcc = ascii(b, 12, 4);
  if (fourcc === 'VP8X') {
    return { contentType: 'image/webp', width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  }
  if (fourcc === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const w = 1 + (b[21]! | ((b[22]! & 0x3f) << 8));
    const h = 1 + ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10));
    return { contentType: 'image/webp', width: w, height: h };
  }
  if (fourcc === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { contentType: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  return null;
}

/** Type + dimensions from magic bytes, or null when the bytes are not a PNG/JPEG/WebP image. */
export function sniffImage(bytes: Uint8Array): ImageMeta | null {
  return sniffPng(bytes) ?? sniffJpeg(bytes) ?? sniffWebp(bytes);
}

/** Authoritative validation for an upload. Throws ApiError 400 (not an accepted image) or 413 (over a cap). */
export function validateImage(bytes: Uint8Array, kind: ImageKind): ValidatedImage {
  const { maxBytes, maxDim } = IMAGE_LIMITS[kind];
  if (bytes.length === 0) throw new ApiError('bad_request', 'The file is empty');
  if (bytes.length > maxBytes) throw new ApiError('too_large', `The image is over ${Math.round(maxBytes / 1000)} KB`);
  const meta = sniffImage(bytes);
  if (!meta) throw new ApiError('bad_request', 'Only PNG, JPEG or WebP images are accepted');
  if (meta.width < 1 || meta.height < 1) throw new ApiError('bad_request', 'The image has no size');
  if (meta.width > maxDim || meta.height > maxDim)
    throw new ApiError('too_large', `The image is larger than ${maxDim} px`);
  return { ...meta, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
