import type { BrandView } from '../page';
import type { RecipeRow } from './rows';

export interface BrandTile extends BrandView {
  cards: number;
  menus: number;
  afc: number | null;
  over: number;
  locked: number;
  onSolid: string;
  text: string;
}

/** Legacy vBrands (2564) numbers, computed per brand from the caller's costed cards. */
export function brandTiles(
  brands: BrandView[],
  rows: RecipeRow[],
  target: number,
  pal: (b: BrandView) => { onSolid: string; text: string },
): BrandTile[] {
  return brands.map((b) => {
    const rs = rows.filter((r) => r.brandId === b.id);
    const menus = rs.filter((r) => r.type === 'menu');
    const priced = menus.filter((r) => r.c.sp > 0);
    const afc = priced.length ? priced.reduce((a, r) => a + (r.c.fcPct as number), 0) / priced.length : null;
    return {
      ...b,
      cards: rs.length,
      menus: menus.length,
      afc,
      over: priced.filter((r) => (r.c.fcPct as number) > target).length,
      locked: rs.filter((r) => r.status === 'LOCKED').length,
      ...pal(b),
    };
  });
}
