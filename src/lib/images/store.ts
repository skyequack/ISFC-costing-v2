import type { Queryable } from '../db/client';
import type { ImageKind, ValidatedImage } from './sniff';

/**
 * The only door to image bytes (D-49). V1 implementation = Postgres bytea; moving to Vercel Blob/S3 later means
 * a new implementation of this interface plus a copy job — routes, DTOs and UI do not change.
 * Callers pass an already validated image (validateImage) and have already done auth, brand-scope and lock checks.
 */
export interface StoredImage {
  contentType: string;
  data: Buffer;
  sha256: string;
  size: number;
  width: number;
  height: number;
}

export interface ImageStore {
  put(ownerId: string, image: ValidatedImage, bytes: Uint8Array): Promise<void>;
  get(ownerId: string): Promise<StoredImage | null>;
  /** Returns whether a row existed. */
  delete(ownerId: string): Promise<boolean>;
  /** Metadata only — never selects the bytes. */
  meta(ownerId: string): Promise<Omit<StoredImage, 'data'> | null>;
}

const TABLES: Record<ImageKind, { table: string; owner: string }> = {
  photo: { table: 'recipe_photo', owner: 'recipe_id' },
  logo: { table: 'brand_logo', owner: 'brand_id' },
};

export function pgImageStore(db: Queryable, kind: ImageKind): ImageStore {
  const { table, owner } = TABLES[kind];
  return {
    async put(ownerId, image, bytes) {
      await db.query(
        `INSERT INTO ${table} (${owner}, content_type, data, size, width, height, sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (${owner}) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data,
           size = EXCLUDED.size, width = EXCLUDED.width, height = EXCLUDED.height, sha256 = EXCLUDED.sha256`,
        [ownerId, image.contentType, Buffer.from(bytes), image.size, image.width, image.height, image.sha256],
      );
    },
    async get(ownerId) {
      const { rows } = await db.query(
        `SELECT content_type, data, sha256, size, width, height FROM ${table} WHERE ${owner} = $1`,
        [ownerId],
      );
      const r = rows[0];
      return r
        ? {
            contentType: r.content_type,
            data: r.data,
            sha256: r.sha256,
            size: r.size,
            width: r.width,
            height: r.height,
          }
        : null;
    },
    async delete(ownerId) {
      const { rows } = await db.query(`DELETE FROM ${table} WHERE ${owner} = $1 RETURNING ${owner}`, [ownerId]);
      return rows.length > 0;
    },
    async meta(ownerId) {
      const { rows } = await db.query(
        `SELECT content_type, sha256, size, width, height FROM ${table} WHERE ${owner} = $1`,
        [ownerId],
      );
      const r = rows[0];
      return r
        ? { contentType: r.content_type, sha256: r.sha256, size: r.size, width: r.width, height: r.height }
        : null;
    },
  };
}
