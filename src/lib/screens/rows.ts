import { cost, type CostResult } from '@/domain/costing';
import type { Catalog } from '../db/catalog';
import { canSeeBrand, type BrandScope } from '../db/scope';
import type { StockClass } from '../units';

/** Slim cost facts the list screens need (serialisable; everything else is recomputed on the card). */
export interface CostFacts {
  batch: number;
  err: string;
  out: number;
  food: number;
  totalCost: number;
  net: number;
  sp: number;
  fcPct: number | null;
  npPct: number | null;
  bOut: number;
  bUom: string;
  unitCost: number | null;
}

export interface RecipeRow {
  id: string;
  code: string;
  name: string;
  cat: string;
  stockClass: StockClass | null;
  type: 'menu' | 'sub';
  brandId: string;
  status: 'DRAFT' | 'LOCKED';
  nLines: number;
  c: CostFacts;
}

export const facts = (c: CostResult): CostFacts => ({
  batch: c.batch,
  err: c.err,
  out: c.out,
  food: c.food,
  totalCost: c.totalCost,
  net: c.net,
  sp: c.sp,
  fcPct: c.fcPct,
  npPct: c.npPct,
  bOut: c.bOut,
  bUom: c.bUom,
  unitCost: c.unitCost,
});

/** Every live card the caller may see, costed with the full (unscoped) catalog — costing crosses brands. */
export function recipeRows(catalog: Catalog, scope: BrandScope): RecipeRow[] {
  const out: RecipeRow[] = [];
  for (const r of catalog.context.recipes.values()) {
    const meta = catalog.cards[r.code];
    if (!meta || meta.id !== r.id || !canSeeBrand(scope, meta.brandId)) continue;
    out.push({
      id: meta.id,
      code: r.code,
      name: r.name,
      cat: meta.category,
      stockClass: meta.stockClass,
      type: r.type,
      brandId: meta.brandId,
      status: meta.status,
      nLines: r.lines.filter((l) => l.code).length,
      c: facts(cost(r, catalog.context)),
    });
  }
  return out;
}
