import { unstable_cache } from 'next/cache';
import { db } from './client';
import { buildCatalog, loadCatalogData, type Catalog } from './catalog';

export const CATALOG_TAG = 'catalog';

/**
 * D-99: the key carries a version and the entry expires after 6 hours. Vercel's data cache outlives deployments, so an entry
 * written while the database was empty (before the 2026-10-12 seed) stayed empty for ever: only a write calls
 * revalidateTag. Bump the version whenever data is changed outside the app (seed, restore of a database); the expiry is
 * the safety net (6 h, so it costs about one catalog read per quiet period, not per request).
 */
const cachedData = unstable_cache(() => loadCatalogData(db), ['catalog-data', 'v2'], {
  tags: [CATALOG_TAG],
  revalidate: 6 * 60 * 60,
});

/**
 * Cached catalog (D-40). Every mutation of ingredients / recipes / conversions / settings must call
 * revalidateTag(CATALOG_TAG). unstable_cache stores JSON, so the plain rows are cached and the lookup
 * Maps are rebuilt per request (~8k rows, milliseconds). Brand filtering happens after this call.
 */
export async function getCatalog(): Promise<Catalog> {
  return buildCatalog(await cachedData());
}
