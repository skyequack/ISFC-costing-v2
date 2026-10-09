import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { IMAGE_LIMITS, sniffImage, validateImage } from '@/lib/images';

const assets = path.resolve(__dirname, '../public/assets');
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w: number, h: number, extra = 0) =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    0x49,
    0x48,
    0x44,
    0x52,
    ...be32(w),
    ...be32(h),
    8,
    6,
    0,
    0,
    0,
    ...new Array(extra).fill(0),
  ]);
const jpeg = (w: number, h: number) =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    16,
    0x4a,
    0x46,
    0x49,
    0x46,
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    0xc0,
    0,
    17,
    8,
    h >> 8,
    h & 255,
    w >> 8,
    w & 255,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ]);
const riff = (fourcc: string, body: number[]) => {
  const chunk = [...fourcc].map((c) => c.charCodeAt(0));
  const size = body.length + 12;
  return new Uint8Array([
    0x52,
    0x49,
    0x46,
    0x46,
    size & 255,
    0,
    0,
    0,
    0x57,
    0x45,
    0x42,
    0x50,
    ...chunk,
    body.length & 255,
    0,
    0,
    0,
    ...body,
    ...new Array(8).fill(0),
  ]);
};
const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const webpX = (w: number, h: number) => riff('VP8X', [0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
const webpL = (w: number, h: number) => {
  const wm = w - 1,
    hm = h - 1;
  return riff('VP8L', [0x2f, wm & 255, ((wm >> 8) & 0x3f) | ((hm & 3) << 6), (hm >> 2) & 255, (hm >> 10) & 15]);
};
const webpLossy = (w: number, h: number) => riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, w & 255, w >> 8, h & 255, h >> 8]);

describe('sniffImage', () => {
  it('reads real seeded PNG logos (type, size)', () => {
    const f = fs.readFileSync(path.join(assets, 'dietworld-logo.png'));
    expect(sniffImage(f)).toEqual({ contentType: 'image/png', width: 420, height: 191 });
  });

  it('PNG / JPEG / WebP (VP8X, VP8L, VP8) dimensions', () => {
    expect(sniffImage(png(320, 110))).toEqual({ contentType: 'image/png', width: 320, height: 110 });
    expect(sniffImage(jpeg(760, 507))).toEqual({ contentType: 'image/jpeg', width: 760, height: 507 });
    expect(sniffImage(webpX(800, 600))).toEqual({ contentType: 'image/webp', width: 800, height: 600 });
    expect(sniffImage(webpL(640, 480))).toEqual({ contentType: 'image/webp', width: 640, height: 480 });
    expect(sniffImage(webpL(5000, 3000))).toEqual({ contentType: 'image/webp', width: 5000, height: 3000 });
    expect(sniffImage(webpLossy(1024, 768))).toEqual({ contentType: 'image/webp', width: 1024, height: 768 });
  });

  it.each([
    ['SVG', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')],
    ['HTML named like an image', new TextEncoder().encode('<html><script>alert(1)</script></html>')],
    [
      'GIF',
      new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ],
    ['empty', new Uint8Array(0)],
    ['truncated PNG', png(10, 10).subarray(0, 12)],
    [
      'PNG signature, wrong IHDR',
      (() => {
        const p = png(10, 10).slice();
        p[12] = 0x58;
        return p;
      })(),
    ],
    ['JPEG without frame header', new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0])],
    [
      'RIFF that is not WebP',
      (() => {
        const p = webpX(10, 10).slice();
        p[8] = 0x41;
        return p;
      })(),
    ],
    [
      'VP8 without start code',
      (() => {
        const p = webpLossy(10, 10).slice();
        p[23] = 0;
        return p;
      })(),
    ],
  ])('rejects %s', (_n, bytes) => expect(sniffImage(bytes)).toBeNull());
});

describe('validateImage', () => {
  it('returns meta, size and sha256 for a real file', () => {
    const f = fs.readFileSync(path.join(assets, 'salus-logo.png'));
    const v = validateImage(f, 'logo');
    expect(v).toMatchObject({ contentType: 'image/png', width: 148, height: 148, size: f.length });
    expect(v.sha256).toBe(createHash('sha256').update(f).digest('hex'));
  });

  it('all 9 seeded brand logos are valid logos', () => {
    const brands: { logoFile: string | null }[] = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../db/seed-data/brands.json'), 'utf8'),
    );
    const files = brands.map((b) => b.logoFile).filter(Boolean) as string[];
    expect(files).toHaveLength(9);
    for (const f of files) expect(() => validateImage(fs.readFileSync(path.join(assets, f)), 'logo'), f).not.toThrow();
  });

  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return 'no-throw';
  };

  it('400 for empty / not an image, ignoring anything the client claims', () => {
    expect(code(() => validateImage(new Uint8Array(0), 'photo'))).toBe('bad_request');
    expect(code(() => validateImage(new TextEncoder().encode('<svg/>'), 'logo'))).toBe('bad_request');
  });

  it('413 over the byte cap (photo 1.5 MB, logo 512 KB) before any parsing', () => {
    expect(code(() => validateImage(png(10, 10, IMAGE_LIMITS.logo.maxBytes), 'logo'))).toBe('too_large');
    expect(code(() => validateImage(png(10, 10, IMAGE_LIMITS.logo.maxBytes - 40), 'logo'))).toBe('no-throw');
    expect(code(() => validateImage(png(10, 10, IMAGE_LIMITS.photo.maxBytes), 'photo'))).toBe('too_large');
  });

  it('413 over the pixel cap; 0-size images rejected', () => {
    expect(code(() => validateImage(png(1025, 100), 'logo'))).toBe('too_large');
    expect(code(() => validateImage(png(1024, 1024), 'logo'))).toBe('no-throw');
    expect(code(() => validateImage(png(4097, 10), 'photo'))).toBe('too_large');
    expect(code(() => validateImage(png(0, 10), 'photo'))).toBe('bad_request');
  });
});
