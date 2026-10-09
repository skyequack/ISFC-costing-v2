import { revalidateTag } from 'next/cache';
import type { SessionUser } from './auth/types';
import { db, withDirectTransaction, withTransaction, type Queryable } from './db/client';
import { CATALOG_TAG } from './db/catalog-cache';
import { visibleBrandIds, type BrandScope } from './db/scope';

/** Run a mutation in one transaction with the caller's brand scope resolved INSIDE it. */
export function inTx<T>(user: SessionUser, fn: (tx: Queryable, scope: BrandScope) => Promise<T>): Promise<T> {
  return withTransaction(async (tx) => fn(tx, await visibleBrandIds(user, tx)));
}

/** Read-only variant on the pool (no transaction). */
export async function withScope<T>(user: SessionUser, fn: (q: Queryable, scope: BrandScope) => Promise<T>): Promise<T> {
  return fn(db, await visibleBrandIds(user, db));
}

/** Every mutation of ingredients / recipes / conversions / settings must call this after it commits (D-40). */
export function bustCatalog(): void {
  revalidateTag(CATALOG_TAG);
}

export const noStore = { 'cache-control': 'private, no-store' } as const;

/** Like inTx but on the direct connection (long / large operations). */
export function inDirectTx<T>(user: SessionUser, fn: (tx: Queryable, scope: BrandScope) => Promise<T>): Promise<T> {
  return withDirectTransaction(async (tx) => fn(tx, await visibleBrandIds(user, tx)));
}
