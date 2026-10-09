'use client';

/**
 * Browser-side image preparation (docs/ARCHITECTURE.md §11, D-49): the legacy canvas pipelines, but producing a Blob
 * (uploaded as raw bytes) instead of a data URL. Photos: max 760 px, white background, JPEG q.72 (legacy readPhoto 1314).
 * Logos: 320 px wide PNG, SVG rasterised, 3 MB input cap (legacy pickLogo 4232). The server re-validates everything.
 */
export interface PreparedImage {
  blob: Blob;
  w: number;
  h: number;
  kb: number;
}

const PHOTO_MAX = 760;
const PHOTO_Q = 0.72;

function decode(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject('That image could not be decoded');
    };
    img.src = url;
  });
}

const toBlob = (cv: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob>((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject('That photo could not be used')), type, q));

export async function readPhoto(file: File | undefined | null): Promise<PreparedImage> {
  if (!file) throw 'no file';
  if (!/^image\//.test(file.type)) throw 'That is not an image file';
  const img = await decode(file);
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  const k = Math.min(1, PHOTO_MAX / Math.max(w, h));
  w = Math.max(1, Math.round(w * k));
  h = Math.max(1, Math.round(h * k));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const cx = cv.getContext('2d')!;
  cx.fillStyle = '#fff';
  cx.fillRect(0, 0, w, h);
  cx.drawImage(img, 0, 0, w, h);
  const blob = await toBlob(cv, 'image/jpeg', PHOTO_Q);
  return { blob, w, h, kb: Math.round(blob.size / 1024) };
}

export async function readLogo(file: File | undefined | null): Promise<PreparedImage> {
  if (!file) throw 'no file';
  if (file.size > 3 * 1024 * 1024) throw 'That image is over 3 MB - use a smaller one';
  if (!/^image\//.test(file.type)) throw 'That is not an image file';
  const img = await decode(file);
  const iw = img.naturalWidth || 320;
  const ih = img.naturalHeight || Math.round(320 / 2);
  const W = 320;
  const H = Math.max(1, Math.round((ih * W) / iw));
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  cv.getContext('2d')!.drawImage(img, 0, 0, W, H);
  let blob = await toBlob(cv, 'image/png');
  // keep the original when it is already smaller (never an SVG: the server stores raster images only)
  if (blob.size > file.size && /^image\/(png|jpeg|webp)$/.test(file.type) && file.size <= 512_000 && iw <= 1024 && ih <= 1024) blob = file;
  return { blob, w: W, h: H, kb: Math.round(blob.size / 1024) };
}

export const imgError = (e: unknown, fallback = 'That photo could not be used'): string => (typeof e === 'string' ? e : fallback);
