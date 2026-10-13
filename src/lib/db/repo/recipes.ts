import { ApiError } from '../../errors';
import type { Queryable } from '../client';
import { camelRow, camelRows } from '../rows';
import type { BrandScope } from '../scope';
import type { StockClass } from '../../units';

/** List DTO: lightweight, no lines, never any image bytes (only the photo's sha for the `?v=` url). */
export interface RecipeListDto {
  id: string;
  code: string;
  name: string;
  category: string;
  /** D-97: label/filter only; null = not set. 'Subrecipe' is derived from `type`, never stored. */
  stockClass: StockClass | null;
  type: 'MENU' | 'SUB';
  brandId: string;
  output: number;
  sellingPrice: number;
  buffer: number | null;
  status: 'DRAFT' | 'LOCKED';
  lockedBy: string | null;
  version: number;
  photoSha: string | null;
  /** bytes of the stored photo (for the "N KB" label), or null. */
  photoSize: number | null;
  updatedAt: Date;
}

export interface RecipeLineDto {
  sortOrder: number;
  code: string;
  qty: number;
  unit: string;
  y: number;
  /** null = fall back to the card buffer (NOT 0). */
  yp: number | null;
  /** three-stage yield (D-70): fractions, null = not set. While any is set, `y` is their product. */
  yThaw: number | null;
  yCut: number | null;
  yCook: number | null;
}

export interface RecipeDto extends RecipeListDto {
  subQty: number;
  subUom: string;
  batchOut: number;
  batchUom: string;
  lockedAt: Date | null;
  costAtLock: unknown;
  lines: RecipeLineDto[];
  method: string[];
  history: { action: 'LOCK' | 'UNLOCK'; who: string; at: Date }[];
}

const COLS = `r.id, r.code, r.name, r.category, r.stock_class, r.type, r.brand_id, r.output, r.selling_price, r.buffer, r.status,
              r.locked_by, r.version, p.sha256 AS photo_sha, p.size AS photo_size, r.updated_at`;
const FROM = 'FROM recipe r LEFT JOIN recipe_photo p ON p.recipe_id = r.id';

/** Live (not soft-deleted) cards in the caller's brands. */
export async function listRecipes(db: Queryable, scope: BrandScope): Promise<RecipeListDto[]> {
  const { rows } = await db.query(
    `SELECT ${COLS} ${FROM} WHERE r.deleted_at IS NULL AND r.brand_id = ANY($1::text[]) ORDER BY r.code`,
    [[...scope.brandIds]],
  );
  return camelRows<RecipeListDto>(rows);
}

/** The columns of a full card: head + lines + method + lock history aggregated in order (one statement, no round trips). */
export const RECIPE_FULL_SELECT = `${COLS}, r.sub_qty, r.sub_uom, r.batch_out, r.batch_uom, r.locked_at, r.cost_at_lock,
            coalesce((SELECT json_agg(json_build_object('sortOrder', l.sort_order, 'code', l.code, 'qty', l.qty,
                                                        'unit', l.unit, 'y', l.y, 'yp', l.yp, 'yThaw', l.y_thaw, 'yCut', l.y_cut,
                                                        'yCook', l.y_cook) ORDER BY l.sort_order)
                        FROM recipe_line l WHERE l.recipe_id = r.id), '[]'::json) AS lines_json,
            coalesce((SELECT json_agg(m.text ORDER BY m.step_number)
                        FROM recipe_method_step m WHERE m.recipe_id = r.id), '[]'::json) AS method_json,
            coalesce((SELECT json_agg(json_build_object('action', h.action, 'who', h.who, 'at', h.created_at)
                                      ORDER BY h.created_at)
                        FROM recipe_history_entry h WHERE h.recipe_id = r.id), '[]'::json) AS history_json`;
export const RECIPE_FULL_FROM = FROM;

/** A row selected with RECIPE_FULL_SELECT -> RecipeDto. */
export function parseRecipeRow(row: Record<string, unknown>): RecipeDto {
  const { lines_json, method_json, history_json, ...head } = row;
  return {
    ...camelRow<Omit<RecipeDto, 'lines' | 'method' | 'history'>>(head),
    lines: lines_json as RecipeLineDto[],
    method: (method_json as unknown[]).map((t) => String(t)),
    history: (history_json as { action: 'LOCK' | 'UNLOCK'; who: string; at: string }[]).map((h) => ({
      ...h,
      at: new Date(h.at),
    })),
  };
}

/** One live card with lines, method and lock history. Unknown OR out-of-scope id -> 404 (indistinguishable). */
export async function getRecipe(db: Queryable, scope: BrandScope, id: string): Promise<RecipeDto> {
  const { rows } = await db.query(
    `SELECT ${RECIPE_FULL_SELECT} ${FROM}
      WHERE r.id = $1 AND r.deleted_at IS NULL AND r.brand_id = ANY($2::text[])`,
    [id, [...scope.brandIds]],
  );
  if (!rows[0]) throw new ApiError('not_found', 'Not found');
  return parseRecipeRow(rows[0] as Record<string, unknown>);
}
