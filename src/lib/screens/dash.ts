import type { Catalog } from '../db/catalog';
import type { IngredientDto } from '../db/repo/ingredients';
import type { BrandView } from '../page';
import type { RecipeRow } from './rows';

export interface DashData {
  target: number;
  menus: number;
  subs: number;
  avgFC: number | null;
  priced: number;
  /** D-30: menu cards left out of the average because they have no selling price. */
  excluded: number;
  /** priced cards averaged in although an ingredient has no price (the cost engine's "no price" error); shown as a note (D-84) */
  incomplete: number;
  over: number;
  loss: number;
  locked: number;
  total: number;
  items: number;
  flagged: number;
  noPrice: number;
  top: RecipeRow[];
  totalMenus: number;
  byBrand: {
    name: string;
    n: number;
    afood: number;
    afc: number | null;
    over: number;
    anet: number | null;
    anp: number | null;
  }[];
  subRows: (RecipeRow & { used: number })[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Legacy vDash (2614) numbers, brand-scoped (D-07) with the excluded-count note (D-30). */
export function dashData(
  rows: RecipeRow[],
  items: IngredientDto[],
  brands: BrandView[],
  catalog: Catalog,
  target: number,
): DashData {
  const menus = rows.filter((r) => r.type === 'menu');
  const subs = rows.filter((r) => r.type === 'sub');
  const priced = menus.filter((r) => r.c.sp > 0);
  const top = [...menus].sort((a, b) => (b.c.fcPct ?? -1) - (a.c.fcPct ?? -1));

  const bmap = new Map<string, RecipeRow[]>();
  for (const r of menus) {
    const k = brands.find((b) => b.id === r.brandId)?.name ?? '— no brand';
    bmap.set(k, [...(bmap.get(k) ?? []), r]);
  }
  const byBrand = [...bmap.keys()].sort().map((k) => {
    const g = bmap.get(k)!;
    const pr = g.filter((x) => x.c.sp > 0);
    return {
      name: k,
      n: g.length,
      afood: g.reduce((a, x) => a + x.c.food, 0) / g.length,
      afc: mean(pr.map((x) => x.c.fcPct as number)),
      over: pr.filter((x) => (x.c.fcPct as number) > target).length,
      anet: mean(pr.map((x) => x.c.net)),
      anp: mean(pr.map((x) => x.c.npPct as number)),
    };
  });

  // "Used in" = cards (in the caller's scope) with a line whose code equals the sub's code (case-sensitive, legacy)
  const used = new Map<string, number>();
  const visible = new Set(rows.map((r) => r.code));
  for (const rec of catalog.context.recipes.values()) {
    if (!visible.has(rec.code)) continue;
    const seen = new Set<string>();
    for (const l of rec.lines) {
      if (!l.code || seen.has(l.code)) continue;
      seen.add(l.code);
      used.set(l.code, (used.get(l.code) ?? 0) + 1);
    }
  }

  return {
    target,
    menus: menus.length,
    subs: subs.length,
    avgFC: mean(priced.map((r) => r.c.fcPct as number)),
    priced: priced.length,
    excluded: menus.length - priced.length,
    incomplete: priced.filter((r) => r.c.err === 'no price').length,
    over: priced.filter((r) => (r.c.fcPct as number) > target).length,
    loss: priced.filter((r) => r.c.net < 0).length,
    locked: rows.filter((r) => r.status === 'LOCKED').length,
    total: rows.length,
    items: items.length,
    flagged: items.filter((i) => i.flag).length,
    noPrice: items.filter((i) => i.price == null).length,
    top: top.slice(0, 25),
    totalMenus: menus.length,
    byBrand,
    subRows: subs.slice(0, 20).map((r) => ({ ...r, used: used.get(r.code) ?? 0 })),
  };
}
