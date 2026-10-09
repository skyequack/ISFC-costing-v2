/**
 * Minimal ZIP reader/writer for .xlsx (legacy rZip / rUnzip, 5087 / 5250). Pure TypeScript, runs in the browser and in Node.
 * Reading is bounded (entry count, declared and actual uncompressed size) so a zip bomb cannot exhaust memory (D-36/D-37).
 */
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

let crcTable: Uint32Array | null = null;
export function crc32(u8: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipFile {
  name: string;
  data: Uint8Array;
}

/** Stored (uncompressed) ZIP — Excel opens it fine. */
export function zipStore(files: ZipFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const cd: Uint8Array[] = [];
  let off = 0;
  for (const f of files) {
    const nm = enc.encode(f.name);
    const crc = crc32(f.data);
    const sz = f.data.length;
    const lh = new Uint8Array(30 + nm.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, sz, true);
    lv.setUint32(22, sz, true);
    lv.setUint16(26, nm.length, true);
    lh.set(nm, 30);
    parts.push(lh, f.data);
    const ch = new Uint8Array(46 + nm.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, sz, true);
    cv.setUint32(24, sz, true);
    cv.setUint16(28, nm.length, true);
    cv.setUint32(42, off, true);
    ch.set(nm, 46);
    cd.push(ch);
    off += lh.length + sz;
  }
  const cdSize = cd.reduce((a, b) => a + b.length, 0);
  const eo = new Uint8Array(22);
  const ev = new DataView(eo.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, off, true);
  const all = new Uint8Array(off + cdSize + 22);
  let p = 0;
  for (const part of [...parts, ...cd, eo]) {
    all.set(part, p);
    p += part.length;
  }
  return all;
}

export class ZipError extends Error {}

export interface UnzipLimits {
  maxEntries: number;
  maxTotalBytes: number;
}
export const DEFAULT_UNZIP_LIMITS: UnzipLimits = { maxEntries: 400, maxTotalBytes: 60 * 1024 * 1024 };

async function inflateRaw(u8: Uint8Array, max: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined')
    throw new ZipError('This browser cannot open .xlsx - save the sheet as CSV UTF-8 and upload that instead.');
  const stream = new Blob([u8 as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new ZipError('That workbook expands to an unreasonable size and was refused.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** Read the XML parts of a zip into memory (deflate and stored; anything else is ignored), bounded against zip bombs. */
export async function unzip(u8: Uint8Array, limits: UnzipLimits = DEFAULT_UNZIP_LIMITS): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eo = -1;
  const stop = Math.max(0, u8.length - 66000);
  for (let i = u8.length - 22; i >= stop; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eo = i;
      break;
    }
  }
  if (eo < 0) throw new ZipError('That file is not a readable .xlsx workbook.');
  const n = dv.getUint16(eo + 10, true);
  if (n > limits.maxEntries) throw new ZipError('That workbook has too many parts and was refused.');
  let p = dv.getUint32(eo + 16, true);
  const out = new Map<string, Uint8Array>();
  let total = 0;
  for (let k = 0; k < n && p + 46 <= u8.length; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true);
    const xl = dv.getUint16(p + 30, true);
    const cl = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    total += usize;
    if (total > limits.maxTotalBytes) throw new ZipError('That workbook expands to an unreasonable size and was refused.');
    const lnl = dv.getUint16(lho + 26, true);
    const lxl = dv.getUint16(lho + 28, true);
    const st = lho + 30 + lnl + lxl;
    const raw = u8.subarray(st, st + csize);
    // only XML parts are needed by a spreadsheet reader; images and the like are skipped without being decompressed
    if (name.endsWith('.xml') || name.endsWith('.rels')) {
      out.set(name, method === 0 ? raw : await inflateRaw(raw, limits.maxTotalBytes));
    }
    p += 46 + nl + xl + cl;
  }
  return out;
}

export const textOf = (b: Uint8Array | undefined): string => (b ? dec.decode(b) : '');
export const bytesOf = (s: string): Uint8Array => enc.encode(s);
