import { cache } from 'react';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getSession } from './auth/session';
import { db } from './db/client';
import { getCatalog } from './db/catalog-cache';
import type { Catalog } from './db/catalog';
import { buildCtx, type BrandView, type PageCtx } from './screens/ctx';

export const WORKSPACE_COOKIE = 'isfc_brand';

/** One session resolution per request (layout + page share it). */
export const pageSession = cache(getSession);

export type { BrandView, PageCtx };

/** Everything a screen needs before it loads its own data. Not signed in / pending -> 404 (the layout shows the card). */
export const pageCtx = cache(async (): Promise<PageCtx> => {
  const s = await pageSession();
  if (s.status !== 'ok') notFound();
  const jar = await cookies();
  return buildCtx(db, s.user, jar.get(WORKSPACE_COOKIE)?.value ?? '');
});

export async function pageCatalog(): Promise<Catalog> {
  return getCatalog();
}
