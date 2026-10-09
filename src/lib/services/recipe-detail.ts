import type { Queryable } from '../db/client';
import { loadCostClosure, type Catalog } from '../db/catalog';
import { getRecipe, type RecipeDto } from '../db/repo/recipes';
import type { BrandScope } from '../db/scope';
import { buildCardView, toCostRecipe, type CardView } from './card-view';

export interface RecipeDetail {
  /** Codes of lines that are packaging (main category Nonfood): Calculate-cost warns about double counting. */
  packaging: string[];
  recipe: RecipeDto & { photoUrl: string | null };
  view: CardView;
  settings: {
    currency: string;
    pkg: number;
    del: number;
    lab: number;
    ops: number;
    buffer: number;
    target: number;
    vat: number;
    priceDate: string;
  };
}

/** The editor payload: stored card + legacy cost result + per-line costs (costing crosses brands, so it is computed server-side). */
export async function recipeDetail(db: Queryable, scope: BrandScope, id: string): Promise<RecipeDetail> {
  const recipe = await getRecipe(db, scope, id);
  // costing needs only what the card's lines can reach, not the whole catalog (D-40 still holds: scope is applied above)
  const codes = [...new Set(recipe.lines.map((l) => l.code).filter(Boolean))];
  const { catalog, packaging } = await loadCostClosure(db, codes, recipe.id);
  return detailFrom(recipe, catalog, packaging);
}

/** The editor payload from a loaded card and its cost closure (shared by the read path and the save path). */
export function detailFrom(recipe: RecipeDto, catalog: Catalog, packaging: string[]): RecipeDetail {
  const view = buildCardView(catalog, toCostRecipe(recipe));
  const s = catalog.settings;
  return {
    packaging,
    recipe: {
      ...recipe,
      photoUrl: recipe.photoSha ? `/api/recipes/${recipe.id}/photo?v=${recipe.photoSha.slice(0, 8)}` : null,
    },
    view,
    settings: {
      currency: s.currency,
      pkg: s.pkg,
      del: s.del,
      lab: s.lab,
      ops: s.ops,
      buffer: s.buffer,
      target: s.target,
      vat: s.vat,
      priceDate: s.priceDate,
    },
  };
}
