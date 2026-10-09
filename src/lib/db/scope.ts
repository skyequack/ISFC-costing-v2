import { ApiError } from '../errors';
import type { SessionUser } from '../auth/types';
import type { Queryable } from './client';

/**
 * Brand scope (D-35). Every repository function that touches brand-tied data takes a BrandScope,
 * which can only be built by visibleBrandIds(). GM = all brands; others = user_brand_access rows;
 * a non-GM with no rows sees nothing.
 */
declare const scopeBrand: unique symbol;
export interface BrandScope {
  readonly [scopeBrand]: true;
  readonly brandIds: readonly string[];
}

export function makeScope(ids: readonly string[]): BrandScope {
  return { brandIds: Object.freeze([...new Set(ids)]) } as unknown as BrandScope;
}

export async function visibleBrandIds(user: Pick<SessionUser, 'id' | 'role'>, db: Queryable): Promise<BrandScope> {
  if (user.role === 'gm') {
    const { rows } = await db.query<{ id: string }>('SELECT id FROM brand ORDER BY id');
    return makeScope(rows.map((r) => r.id));
  }
  const { rows } = await db.query<{ brand_id: string }>(
    'SELECT brand_id FROM user_brand_access WHERE user_id = $1 ORDER BY brand_id',
    [user.id],
  );
  return makeScope(rows.map((r) => r.brand_id));
}

export function canSeeBrand(scope: BrandScope, brandId: string): boolean {
  return scope.brandIds.includes(brandId);
}

/** Out-of-scope resources are indistinguishable from missing ones: 404. */
export function assertBrandVisible(scope: BrandScope, brandId: string | null | undefined): asserts brandId is string {
  if (!brandId || !canSeeBrand(scope, brandId)) throw new ApiError('not_found', 'Not found');
}
