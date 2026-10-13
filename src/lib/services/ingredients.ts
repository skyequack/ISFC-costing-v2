import { pctText } from '@/domain/recipes/yield-stages';
import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { appendAudit } from '../db/repo/audit';
import type { BrandScope } from '../db/scope';
import { ApiError } from '../errors';
import { money } from '../format';
import { can } from '../permissions';
import type { IngredientIn } from '../validation/common';

/** Fixed lock key shared with recipe code allocation (codes are unique across both namespaces). */
export const CODE_LOCK = 8_041_001;

export interface ItemStages {
  yThaw?: number | null;
  yCut?: number | null;
  yCook?: number | null;
}

/** Audit text for the three default stages, e.g. "thaw 90% · cut — · cook 75%" (— = none = 100%). */
function stageText(s: ItemStages): string {
  const p = (v: number | null | undefined) => (v == null ? '—' : `${pctText(v)}%`);
  return `thaw ${p(s.yThaw)} · cut ${p(s.yCut)} · cook ${p(s.yCook)}`;
}

/** The stages themselves, not their rounded text: a change below 0.01 percentage points is still a change. */
function sameStages(a: ItemStages, b: ItemStages): boolean {
  return (
    (a.yThaw ?? null) === (b.yThaw ?? null) &&
    (a.yCut ?? null) === (b.yCut ?? null) &&
    (a.yCook ?? null) === (b.yCook ?? null)
  );
}

function needItems(user: SessionUser): void {
  if (!can(user.role, 'items.edit')) throw new ApiError('forbidden', 'Your role cannot do that');
}

interface Row {
  id: string;
  code: string;
  name: string;
  uom: string;
  price: number | null;
  version: number;
  brandIds: string[];
  yThaw: number | null;
  yCut: number | null;
  yCook: number | null;
}

async function lockItem(tx: Queryable, scope: BrandScope, id: string): Promise<Row> {
  const { rows } = await tx.query(
    `SELECT i.id, i.code, i.name, i.uom, i.price, i.version, i.y_thaw, i.y_cut, i.y_cook,
            coalesce((SELECT array_agg(s.brand_id ORDER BY s.brand_id) FROM item_brand_scope s WHERE s.ingredient_id = i.id), '{}') AS brand_ids
       FROM ingredient i WHERE i.id = $1 FOR UPDATE OF i`,
    [id],
  );
  const r = rows[0];
  if (!r) throw new ApiError('not_found', 'Not found');
  const brandIds = r.brand_ids as string[];
  // shared items are visible to everyone; scoped items only to a user who has one of their brands
  if (brandIds.length && !brandIds.some((b) => scope.brandIds.includes(b)))
    throw new ApiError('not_found', 'Not found');
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    uom: r.uom,
    price: r.price,
    version: r.version,
    brandIds,
    yThaw: r.y_thaw,
    yCut: r.y_cut,
    yCook: r.y_cook,
  };
}

function checkBrandIds(user: SessionUser, scope: BrandScope, ids: string[]): void {
  if (user.role === 'gm') return;
  if (ids.some((b) => !scope.brandIds.includes(b)))
    throw new ApiError('forbidden', 'You have no access to one of those brands');
}

async function assertNewCode(tx: Queryable, code: string): Promise<void> {
  const i = await tx.query('SELECT code FROM ingredient WHERE lower(code) = lower($1)', [code]);
  if (i.rows[0]) throw new ApiError('conflict', `The code ${i.rows[0].code} already exists`);
  const r = await tx.query('SELECT code FROM recipe WHERE lower(code) = lower($1) AND deleted_at IS NULL', [code]);
  if (r.rows[0]) throw new ApiError('conflict', `The code ${r.rows[0].code} is already used by a recipe card`);
}

async function setScope(tx: Queryable, id: string, brandIds: string[]): Promise<void> {
  await tx.query('DELETE FROM item_brand_scope WHERE ingredient_id = $1', [id]);
  if (!brandIds.length) return;
  const ok = await tx.query('SELECT count(*)::int AS n FROM brand WHERE id = ANY($1::text[])', [
    [...new Set(brandIds)],
  ]);
  if (ok.rows[0]!.n !== new Set(brandIds).size) throw new ApiError('bad_request', 'Unknown brand');
  await tx.query(
    'INSERT INTO item_brand_scope (ingredient_id, brand_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING',
    [id, [...new Set(brandIds)]],
  );
}

export async function addPriceHistory(
  tx: Queryable,
  user: Pick<SessionUser, 'id' | 'name'>,
  ingredientId: string,
  oldPrice: number | null,
  newPrice: number | null,
  source: 'MANUAL' | 'IMPORT' | 'MENU_PLAN' | 'SEED',
): Promise<void> {
  await tx.query(
    `INSERT INTO ingredient_price_history (ingredient_id, old_price, new_price, source, user_id, user_name_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [ingredientId, oldPrice, newPrice, source, user.id, user.name],
  );
}

export async function createIngredient(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  input: IngredientIn,
): Promise<string> {
  needItems(user);
  checkBrandIds(user, scope, input.brandIds);
  await tx.query('SELECT pg_advisory_xact_lock($1)', [CODE_LOCK]);
  await assertNewCode(tx, input.code);
  const { rows } = await tx.query(
    `INSERT INTO ingredient (code, name, uom, price, price_updated_at, category, subcategory, flag, y_thaw, y_cut, y_cook)
     VALUES ($1,$2,$3,$4, CASE WHEN $4::float8 IS NULL THEN NULL ELSE now() END, $5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      input.code,
      input.name,
      input.uom,
      input.price,
      input.category || 'Uncategorised',
      input.subcategory || 'Uncategorised',
      input.flag,
      input.yThaw ?? null,
      input.yCut ?? null,
      input.yCook ?? null,
    ],
  );
  const id = rows[0]!.id as string;
  await setScope(tx, id, input.brandIds);
  if (input.price !== null) await addPriceHistory(tx, user, id, null, input.price, 'MANUAL');
  await appendAudit(tx, user, 'Added ingredient', `${input.code} ${input.name}`);
  return id;
}

export async function updateIngredient(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  id: string,
  input: IngredientIn & { version: number },
): Promise<void> {
  needItems(user);
  const cur = await lockItem(tx, scope, id);
  if (cur.version !== input.version)
    throw new ApiError('conflict', 'This ingredient was changed by someone else – reload', {
      currentVersion: cur.version,
    });
  if (input.code !== cur.code) throw new ApiError('bad_request', 'The code of an ingredient cannot be changed');
  checkBrandIds(user, scope, input.brandIds);
  if (user.role !== 'gm' && cur.brandIds.some((b) => !scope.brandIds.includes(b)))
    throw new ApiError('forbidden', 'This ingredient is shared with brands you cannot see – ask the General Manager');
  const priceChanged = input.price !== cur.price;
  // absent = keep (an old client or a price-only edit must not wipe the defaults), null = clear, number = set
  const stages = {
    yThaw: input.yThaw === undefined ? cur.yThaw : input.yThaw,
    yCut: input.yCut === undefined ? cur.yCut : input.yCut,
    yCook: input.yCook === undefined ? cur.yCook : input.yCook,
  };
  const stagesChanged = !sameStages(cur, stages);
  await tx.query(
    `UPDATE ingredient SET name=$2, uom=$3, price=$4, category=$5, subcategory=$6, flag=$7, version = version + 1,
            price_updated_at = CASE WHEN $8 THEN now() ELSE price_updated_at END,
            y_thaw = $10, y_cut = $11, y_cook = $12
      WHERE id = $1 AND version = $9`,
    [
      id,
      input.name,
      input.uom,
      input.price,
      input.category || 'Uncategorised',
      input.subcategory || 'Uncategorised',
      input.flag,
      priceChanged,
      input.version,
      stages.yThaw,
      stages.yCut,
      stages.yCook,
    ],
  );
  await setScope(tx, id, input.brandIds);
  if (priceChanged) {
    await addPriceHistory(tx, user, id, cur.price, input.price, 'MANUAL');
    await appendAudit(
      tx,
      user,
      'Changed purchase price',
      `${cur.code} ${input.name}: ${money(cur.price ?? 0, 6)} → ${money(input.price ?? 0, 6)}`,
    );
  } else if (!stagesChanged) await appendAudit(tx, user, 'Edited ingredient', cur.code);
  if (stagesChanged)
    await appendAudit(tx, user, 'Changed default yields', `${cur.code}: ${stageText(cur)} → ${stageText(stages)}`);
}

/** Save only the default yield stages of one raw material, found by code (D-93; the line editor's "Save to raw material"). */
export async function setIngredientYields(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  input: ItemStages & { code: string },
): Promise<void> {
  needItems(user);
  const found = await tx.query('SELECT id FROM ingredient WHERE code = $1', [input.code]);
  if (!found.rows[0]) throw new ApiError('not_found', 'Not found');
  const cur = await lockItem(tx, scope, found.rows[0].id as string);
  if (user.role !== 'gm' && cur.brandIds.some((b) => !scope.brandIds.includes(b)))
    throw new ApiError('forbidden', 'This ingredient is shared with brands you cannot see – ask the General Manager');
  const next = { yThaw: input.yThaw ?? null, yCut: input.yCut ?? null, yCook: input.yCook ?? null };
  if (sameStages(cur, next)) return;
  await tx.query('UPDATE ingredient SET y_thaw = $2, y_cut = $3, y_cook = $4, version = version + 1 WHERE id = $1', [
    cur.id,
    next.yThaw,
    next.yCut,
    next.yCook,
  ]);
  await appendAudit(tx, user, 'Changed default yields', `${cur.code}: ${stageText(cur)} → ${stageText(next)}`);
}

export async function deleteIngredient(tx: Queryable, user: SessionUser, scope: BrandScope, id: string): Promise<void> {
  needItems(user);
  const cur = await lockItem(tx, scope, id);
  const used = await tx.query(
    `SELECT count(DISTINCT l.recipe_id)::int AS n FROM recipe_line l JOIN recipe r ON r.id = l.recipe_id AND r.deleted_at IS NULL WHERE l.code = $1`,
    [cur.code],
  );
  const cards = used.rows[0]!.n as number;
  const cells = (
    await tx.query(`SELECT count(*)::int AS n FROM menu_cell WHERE kind = 'ITEM' AND code = $1`, [cur.code])
  ).rows[0]!.n as number;
  // D-100: an archived revision still costs with this item, so it cannot vanish while one uses it
  const old = (
    await tx.query(
      `SELECT count(DISTINCT v.recipe_id)::int AS n FROM recipe_version_line l JOIN recipe_version v ON v.id = l.version_id JOIN recipe r ON r.id = v.recipe_id AND r.deleted_at IS NULL WHERE l.code = $1`,
      [cur.code],
    )
  ).rows[0]!.n as number;
  if (old)
    throw new ApiError('conflict', `Used by earlier revisions of ${old} card(s) – it cannot be deleted`, {
      cards: old,
    });
  if (cards) throw new ApiError('conflict', `Used by ${cards} card(s) – remove those lines first`, { cards });
  if (cells) throw new ApiError('conflict', `Used by ${cells} menu plan cell(s) – change those first`, { cells });
  await tx.query('DELETE FROM ingredient WHERE id = $1', [id]); // conversion + scope rows cascade
  await appendAudit(tx, user, 'Deleted ingredient', cur.code);
}

export async function setConversion(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  ingredientId: string,
  recipeUnit: string,
  factor: number,
): Promise<void> {
  if (!can(user.role, 'conv.edit')) throw new ApiError('forbidden', 'Your role cannot do that');
  const item = await lockItem(tx, scope, ingredientId);
  if (!(factor > 0) || !isFinite(factor))
    throw new ApiError('bad_request', 'That number does not give a usable factor');
  if (recipeUnit.toLowerCase().trim() === item.uom.toLowerCase().trim())
    throw new ApiError('unprocessable', `${recipeUnit} is already how this item is priced – no conversion needed`);
  await tx.query(
    `INSERT INTO unit_conversion (ingredient_id, recipe_unit, factor) VALUES ($1,$2,$3)
     ON CONFLICT (ingredient_id) DO UPDATE SET recipe_unit = EXCLUDED.recipe_unit, factor = EXCLUDED.factor`,
    [ingredientId, recipeUnit, factor],
  );
  await appendAudit(tx, user, 'Set unit conversion', `${item.code}: 1 ${item.uom} = ${factor} ${recipeUnit}`);
}

export async function removeConversion(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  ingredientId: string,
): Promise<void> {
  if (!can(user.role, 'conv.edit')) throw new ApiError('forbidden', 'Your role cannot do that');
  const item = await lockItem(tx, scope, ingredientId);
  const r = await tx.query('DELETE FROM unit_conversion WHERE ingredient_id = $1', [ingredientId]);
  if (!r.rowCount) throw new ApiError('not_found', 'Not found');
  await appendAudit(tx, user, 'Removed unit conversion', item.code);
}
