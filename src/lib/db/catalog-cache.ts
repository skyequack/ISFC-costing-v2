import { unstable_cache } from 'next/cache';
import { db } from './client';
import { buildCatalog, loadCatalogData, type Catalog } from './catalog';

export const CATALOG_TAG = 'catalog';

const cachedData = unstable_cache(() => loadCatalogData(db), ['catalog-data'], { tags: [CATALOG_TAG] });

/**
 * Cached catalog (D-40). Every mutation of ingredients / recipes / conversions / settings must call
 * revalidateTag(CATALOG_TAG). unstable_cache stores JSON, so the plain rows are cached and the lookup
 * Maps are rebuilt per request (~8k rows, milliseconds). Brand filtering happens after this call.
 */
export async function getCatalog(): Promise<Catalog> {
  return buildCatalog(await cachedData());
}
