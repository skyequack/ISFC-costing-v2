import type { Queryable } from '../client';
import { camelRows } from '../rows';
import type { BrandScope } from '../scope';

export interface IngredientDto {
  id: string;
  code: string;
  name: string;
  uom: string;
  /** null = PRICE MISSING. Never coerced to 0. */
  price: number | null;
  category: string;
  subcategory: string;
  flag: string;
  version: number;
  /** [] = Shared (visible to every brand). */
  brandIds: string[];
  conv: { recipeUnit: string; factor: number } | null;
}

/**
 * Ingredients visible to the scope: Shared (no item_brand_scope rows) or scoped to at least one visible brand.
 * Ordered by code for a stable listing.
 */
export async function listIngredients(db: Queryable, scope: BrandScope): Promise<IngredientDto[]> {
  const { rows } = await db.query(
    `SELECT i.id, i.code, i.name, i.uom, i.price, i.category, i.subcategory, i.flag, i.version,
            coalesce((SELECT array_agg(s.brand_id ORDER BY s.brand_id) FROM item_brand_scope s WHERE s.ingredient_id = i.id), '{}') AS brand_ids,
            CASE WHEN c.ingredient_id IS NULL THEN NULL
                 ELSE jsonb_build_object('recipeUnit', c.recipe_unit, 'factor', c.factor) END AS conv
     FROM ingredient i
     LEFT JOIN unit_conversion c ON c.ingredient_id = i.id
     WHERE NOT EXISTS (SELECT 1 FROM item_brand_scope s WHERE s.ingredient_id = i.id)
        OR EXISTS (SELECT 1 FROM item_brand_scope s WHERE s.ingredient_id = i.id AND s.brand_id = ANY($1::text[]))
     ORDER BY i.code`,
    [[...scope.brandIds]],
  );
  return camelRows<IngredientDto>(rows);
}

/**
 * Which of `codes` are ingredients the caller can use: shared ones (no brand scope) or ones scoped to a brand in their
 * scope (the same rule as listIngredients, one indexed lookup for the codes given instead of the whole catalog).
 */
export async function ingredientCodesInScope(
  db: Queryable,
  scope: BrandScope,
  codes: readonly string[],
): Promise<Set<string>> {
  if (!codes.length) return new Set();
  const { rows } = await db.query<{ code: string }>(
    `SELECT i.code FROM ingredient i
      WHERE i.code = ANY($1::text[])
        AND (NOT EXISTS (SELECT 1 FROM item_brand_scope s WHERE s.ingredient_id = i.id)
             OR EXISTS (SELECT 1 FROM item_brand_scope s WHERE s.ingredient_id = i.id AND s.brand_id = ANY($2::text[])))`,
    [[...codes], [...scope.brandIds]],
  );
  return new Set(rows.map((r) => r.code));
}
