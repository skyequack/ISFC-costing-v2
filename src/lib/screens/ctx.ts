import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { listBrands, type BrandDto } from '../db/repo/brands';
import { visibleBrandIds, type BrandScope } from '../db/scope';
import { menusVisible } from '../services/planning';

export type BrandView = BrandDto & { logoUrl: string | null };

export interface PageCtx {
  user: SessionUser;
  scope: BrandScope;
  brands: BrandView[];
  /** Active workspace (legacy S.activeBrand): '' = none. Cookie value, re-validated against the scope. */
  workspaceId: string;
  menusVisible: boolean;
}

export const withLogo = (b: BrandDto): BrandView => ({
  ...b,
  logoUrl: b.logoSha ? `/api/brands/${b.id}/logo?v=${b.logoSha.slice(0, 8)}` : null,
});

/** Brand scope, brands and the SSEM gate for a user: the same context for pages and for export routes. */
export async function buildCtx(db: Queryable, user: SessionUser, wantedWorkspace = ''): Promise<PageCtx> {
  const scope = await visibleBrandIds(user, db);
  const brands = (await listBrands(db, scope)).map(withLogo);
  return {
    user,
    scope,
    brands,
    workspaceId: brands.some((b) => b.id === wantedWorkspace) ? wantedWorkspace : '',
    menusVisible: await menusVisible(db, scope),
  };
}
