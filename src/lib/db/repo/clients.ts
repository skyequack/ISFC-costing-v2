import type { Queryable } from '../client';
import { camelRows } from '../rows';
import { assertBrandVisible, type BrandScope } from '../scope';

export interface ClientDto {
  id: string;
  brandId: string;
  name: string;
  active: boolean;
  version: number;
}

const SELECT = 'SELECT id, brand_id, name, active, version FROM client';

/** Clients of the brands in the caller's scope, by brand then name (D-71). */
export async function listClients(db: Queryable, scope: BrandScope): Promise<ClientDto[]> {
  const { rows } = await db.query(`${SELECT} WHERE brand_id = ANY($1::text[]) ORDER BY brand_id, lower(name)`, [
    [...scope.brandIds],
  ]);
  return camelRows<ClientDto>(rows);
}

/**
 * Out-of-scope or unknown id -> ApiError 404 (D-07). `lock` takes a row lock for the rest of the transaction: 'share' while
 * a production row is written for the client, 'update' while the client is changed or deleted, so the two cannot interleave
 * (production_entry.client_id has no foreign key, D-71).
 */
export async function getClient(
  db: Queryable,
  scope: BrandScope,
  id: string,
  lock?: 'share' | 'update',
): Promise<ClientDto> {
  const { rows } = await db.query(
    `${SELECT} WHERE id = $1${lock === 'update' ? ' FOR UPDATE' : lock === 'share' ? ' FOR SHARE' : ''}`,
    [id],
  );
  const c = camelRows<ClientDto>(rows)[0];
  assertBrandVisible(scope, c?.brandId);
  return c!;
}
