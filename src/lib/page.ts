import { cache } from 'react';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getSession } from './auth/session';
import type { SessionUser } from './auth/types';
import { db } from './db/client';
import { getCatalog } from './db/catalog-cache';
import type { Catalog } from './db/catalog';
import { listBrands, type BrandDto } from './db/repo/brands';
import { visibleBrandIds, type BrandScope } from './db/scope';
import { menusVisible } from './services/planning';

export const WORKSPACE_COOKIE = 'isfc_brand';

/** One session resolution per request (layout + page share it). */
export const pageSession = cache(getSession);

export type BrandView = BrandDto & { logoUrl: string | null };

export interface PageCtx {
  user: SessionUser;
  scope: BrandScope;
  brands: BrandView[];
  /** Active workspace (legacy S.activeBrand): '' = none. Cookie value, re-validated against the scope. */
  workspaceId: string;
  menusVisible: boolean;
}

const withLogo = (b: BrandDto): BrandView => ({
  ...b,
  logoUrl: b.logoSha ? `/api/brands/${b.id}/logo?v=${b.logoSha.slice(0, 8)}` : null,
});

/** Everything a screen needs before it loads its own data. Not signed in / pending -> 404 (the layout shows the card). */
export const pageCtx = cache(async (): Promise<PageCtx> => {
  const s = await pageSession();
  if (s.status !== 'ok') notFound();
  const scope = await visibleBrandIds(s.user, db);
  const brands = (await listBrands(db, scope)).map(withLogo);
  const jar = await cookies();
  const wanted = jar.get(WORKSPACE_COOKIE)?.value ?? '';
  return {
    user: s.user,
    scope,
    brands,
    workspaceId: brands.some((b) => b.id === wanted) ? wanted : '',
    menusVisible: await menusVisible(db, scope),
  };
});

export async function pageCatalog(): Promise<Catalog> {
  return getCatalog();
}
