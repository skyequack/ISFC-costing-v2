import type { PrismaClient } from '@prisma/client';
import { ApiError } from '../errors';
import type { SessionUser } from '../auth/types';

/**
 * Brand scope (D-35). Every repository function that touches brand-tied data takes a BrandScope,
 * which can only be built by visibleBrandIds(). GM = all brands; others = UserBrandAccess rows;
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

export async function visibleBrandIds(user: Pick<SessionUser, 'id' | 'role'>, db: PrismaClient): Promise<BrandScope> {
  if (user.role === 'gm') {
    const all = await db.brand.findMany({ select: { id: true } });
    return makeScope(all.map((b) => b.id));
  }
  const rows = await db.userBrandAccess.findMany({ where: { userId: user.id }, select: { brandId: true } });
  return makeScope(rows.map((r) => r.brandId));
}

export function canSeeBrand(scope: BrandScope, brandId: string): boolean {
  return scope.brandIds.includes(brandId);
}

/** Out-of-scope resources are indistinguishable from missing ones: 404. */
export function assertBrandVisible(scope: BrandScope, brandId: string | null | undefined): asserts brandId is string {
  if (!brandId || !canSeeBrand(scope, brandId)) throw new ApiError('not_found', 'Not found');
}
