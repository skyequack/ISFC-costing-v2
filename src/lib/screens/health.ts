import { lineCost, num } from '@/domain/costing';
import type { Catalog } from '../db/catalog';
import type { IngredientDto } from '../db/repo/ingredients';
import { canSeeBrand, type BrandScope } from '../db/scope';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM';
export interface HealthRow {
  sev: Severity;
  where: string;
  problem: string;
  why: string;
}

/** Legacy vHealth (4318) live checks, over the caller's items and cards. Wording of the "needs conversion" row corrected (bug 22). */
export function healthRows(catalog: Catalog, scope: BrandScope, items: IngredientDto[]): HealthRow[] {
  const live: HealthRow[] = [];
  for (const i of items)
    if (i.price == null)
      live.push({
        sev: 'CRITICAL',
        where: `${i.code} ${i.name}`,
        problem: 'No price on file',
        why: 'Any card using it costs at zero.',
      });
  for (const r of catalog.context.recipes.values()) {
    const meta = catalog.cards[r.code];
    if (!meta || meta.id !== r.id || !canSeeBrand(scope, meta.brandId)) continue;
    for (const l of r.lines) {
      if (!l.code) continue;
      const c = lineCost(l, catalog.context);
      if (c.kind === 'none')
        live.push({
          sev: 'CRITICAL',
          where: r.name,
          problem: `Unknown code ${l.code}`,
          why: 'That line contributes nothing.',
        });
      else if (c.needConv)
        live.push({
          sev: 'HIGH',
          where: r.name,
          problem: `${l.code} priced per ${c.uom} but the recipe asks for ${l.unit}`,
          why: 'No conversion exists, so the line costs nothing.',
        });
    }
    if (r.type === 'menu' && !num(r.price))
      live.push({ sev: 'MEDIUM', where: r.name, problem: 'No sales price', why: 'Food cost % cannot be measured.' });
    if (r.type === 'sub' && !num(r.batchOut))
      live.push({ sev: 'HIGH', where: r.name, problem: 'No batch output', why: 'Cost per unit cannot be worked out.' });
    if (!r.code)
      live.push({
        sev: 'MEDIUM',
        where: r.name,
        problem: 'No recipe code',
        why: 'It cannot be called by another card.',
      });
  }
  return live;
}
