import { ApiError } from '../../errors';
import type { Queryable } from '../client';
import { camelRow, camelRows } from '../rows';
import type { BrandScope } from '../scope';

/** List DTO: lightweight, no lines, never any image bytes (only the photo's sha for the `?v=` url). */
export interface RecipeListDto {
  id: string;
  code: string;
  name: string;
  category: string;
  type: 'MENU' | 'SUB';
  brandId: string;
  output: number;
  sellingPrice: number;
  buffer: number | null;
  status: 'DRAFT' | 'LOCKED';
  lockedBy: string | null;
  version: number;
  photoSha: string | null;
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

const COLS = `r.id, r.code, r.name, r.category, r.type, r.brand_id, r.output, r.selling_price, r.buffer, r.status,
              r.locked_by, r.version, p.sha256 AS photo_sha, r.updated_at`;
const FROM = 'FROM recipe r LEFT JOIN recipe_photo p ON p.recipe_id = r.id';

/** Live (not soft-deleted) cards in the caller's brands. */
export async function listRecipes(db: Queryable, scope: BrandScope): Promise<RecipeListDto[]> {
  const { rows } = await db.query(
    `SELECT ${COLS} ${FROM} WHERE r.deleted_at IS NULL AND r.brand_id = ANY($1::text[]) ORDER BY r.code`,
    [[...scope.brandIds]],
  );
  return camelRows<RecipeListDto>(rows);
}

/** One live card with lines, method and lock history. Unknown OR out-of-scope id -> 404 (indistinguishable). */
export async function getRecipe(db: Queryable, scope: BrandScope, id: string): Promise<RecipeDto> {
  const head = await db.query(
    `SELECT ${COLS}, r.sub_qty, r.sub_uom, r.batch_out, r.batch_uom, r.locked_at, r.cost_at_lock ${FROM}
     WHERE r.id = $1 AND r.deleted_at IS NULL AND r.brand_id = ANY($2::text[])`,
    [id, [...scope.brandIds]],
  );
  if (!head.rows[0]) throw new ApiError('not_found', 'Not found');
  const lines = await db.query(
    'SELECT sort_order, code, qty, unit, y, yp FROM recipe_line WHERE recipe_id = $1 ORDER BY sort_order',
    [id],
  );
  const method = await db.query('SELECT text FROM recipe_method_step WHERE recipe_id = $1 ORDER BY step_number', [id]);
  const history = await db.query(
    'SELECT action, who, created_at AS at FROM recipe_history_entry WHERE recipe_id = $1 ORDER BY created_at',
    [id],
  );
  return {
    ...camelRow<Omit<RecipeDto, 'lines' | 'method' | 'history'>>(head.rows[0]),
    lines: camelRows<RecipeLineDto>(lines.rows),
    method: method.rows.map((r) => String(r.text)),
    history: camelRows<RecipeDto['history'][number]>(history.rows),
  };
}
