import type { Queryable } from '../client';
import { camelRows } from '../rows';
import { assertBrandVisible, type BrandScope } from '../scope';

export interface BrandDto {
  id: string;
  legacyId: string;
  code: string;
  name: string;
  nameAr: string | null;
  color: string;
  inkColor: string | null;
  locations: string[];
  active: boolean;
  /** sha256 of the stored logo, or null. The bytes are only ever read through the ImageStore. */
  logoSha: string | null;
}

const SELECT = `SELECT b.id, b.legacy_id, b.code, b.name, b.name_ar, b.color, b.ink_color, b.locations, b.active,
                       l.sha256 AS logo_sha
                FROM brand b LEFT JOIN brand_logo l ON l.brand_id = b.id`;

export async function listBrands(db: Queryable, scope: BrandScope): Promise<BrandDto[]> {
  const { rows } = await db.query(`${SELECT} WHERE b.id = ANY($1::text[]) ORDER BY b.legacy_id <> 'bnc', b.name`, [
    [...scope.brandIds],
  ]);
  return camelRows<BrandDto>(rows);
}

/** Out-of-scope or unknown id -> ApiError 404. */
export async function getBrand(db: Queryable, scope: BrandScope, id: string): Promise<BrandDto> {
  assertBrandVisible(scope, id);
  const { rows } = await db.query(`${SELECT} WHERE b.id = $1`, [id]);
  if (!rows[0]) assertBrandVisible(scope, null);
  return camelRows<BrandDto>(rows)[0]!;
}
