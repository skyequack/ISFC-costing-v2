import { costWithIssues } from '@/domain/costing';
import { assertAcyclicWith, CycleError, type GraphRecipe } from '@/domain/recipes/graph';
import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { closureSql, loadCatalog, parseClosure, type Catalog, type ClosureRow } from '../db/catalog';
import { appendAudit, auditInsertSql, type AuditEntry } from '../db/repo/audit';
import { getRecipe, parseRecipeRow, RECIPE_FULL_FROM, RECIPE_FULL_SELECT, type RecipeDto } from '../db/repo/recipes';
import { assertBrandVisible, canSeeBrand, type BrandScope } from '../db/scope';
import { ApiError } from '../errors';
import { can, type Permission } from '../permissions';
import { money } from '../format';
import type { StockClass } from '../units';
import { stagedYield } from '@/domain/recipes/yield-stages';
import { normY, type LineIn, type RecipeSaveIn } from '../validation/common';
import { toCostRecipe } from './card-view';
import { detailFrom, recipeDetail, type RecipeDetail } from './recipe-detail';
import { CODE_LOCK } from './ingredients';

/** Fixed lock key so recipe saves serialise their graph check (D-34). */
const GRAPH_LOCK = CODE_LOCK;

function need(user: SessionUser, perm: Permission, message?: string): void {
  if (!can(user.role, perm)) throw new ApiError('forbidden', message ?? 'Your role cannot do that');
}

interface Head {
  id: string;
  code: string;
  name: string;
  category: string;
  stockClass: StockClass | null;
  type: 'MENU' | 'SUB';
  brandId: string;
  output: number;
  subQty: number;
  subUom: string;
  batchOut: number;
  batchUom: string;
  sellingPrice: number;
  buffer: number | null;
  status: 'DRAFT' | 'LOCKED';
  version: number;
}

async function lockHead(tx: Queryable, scope: BrandScope, id: string): Promise<Head> {
  const { rows } = await tx.query(
    `SELECT id, code, name, category, stock_class, type, brand_id, output, sub_qty, sub_uom, batch_out, batch_uom,
            selling_price, buffer, status, version
       FROM recipe WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [id],
  );
  const r = rows[0];
  if (!r || !canSeeBrand(scope, r.brand_id)) throw new ApiError('not_found', 'Not found');
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    category: r.category,
    stockClass: r.stock_class,
    type: r.type,
    brandId: r.brand_id,
    output: r.output,
    subQty: r.sub_qty,
    subUom: r.sub_uom,
    batchOut: r.batch_out,
    batchUom: r.batch_uom,
    sellingPrice: r.selling_price,
    buffer: r.buffer,
    status: r.status,
    version: r.version,
  };
}

/**
 * The save path's load, in ONE statement: the full card (head, lines, method, lock history) under a row lock, and, when
 * `withClosure`, everything costing it needs (its cost closure, settings), so the response can be built without a re-read.
 * Lines and steps are aggregated in order, so the arrays equal what separate ORDER BY queries returned (doubles
 * round-trip through JSON). Scope is checked in TS after the lock, exactly as lockHead did (404 either way).
 */
async function loadForSave(
  tx: Queryable,
  scope: BrandScope,
  id: string,
  withClosure: boolean,
): Promise<{ recipe: RecipeDto; head: Head; closure?: ClosureRow }> {
  const q = withClosure
    ? closureSql(`SELECT DISTINCT sl.code FROM recipe_line sl WHERE sl.recipe_id = $1 AND sl.code <> ''`, '$1')
    : null;
  const { rows } = await tx.query(
    `${q ? `WITH RECURSIVE ${q.cte}` : ''}
     SELECT ${RECIPE_FULL_SELECT}${q ? `, ${q.selects}` : ''}
       ${RECIPE_FULL_FROM} WHERE r.id = $1 AND r.deleted_at IS NULL FOR UPDATE OF r`,
    [id],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new ApiError('not_found', 'Not found');
  const { items, recipes, settings, ...own } = row;
  const recipe = parseRecipeRow(own);
  if (!canSeeBrand(scope, recipe.brandId)) throw new ApiError('not_found', 'Not found');
  const head: Head = {
    id: recipe.id,
    code: recipe.code,
    name: recipe.name,
    category: recipe.category,
    stockClass: recipe.stockClass,
    type: recipe.type,
    brandId: recipe.brandId,
    output: recipe.output,
    subQty: recipe.subQty,
    subUom: recipe.subUom,
    batchOut: recipe.batchOut,
    batchUom: recipe.batchUom,
    sellingPrice: recipe.sellingPrice,
    buffer: recipe.buffer,
    status: recipe.status,
    version: recipe.version,
  };
  return { recipe, head, closure: q ? { items, recipes, settings } : undefined };
}

/** Legacy nextCode (2871): <BRAND>-<SR|MN>-<4 digits>, smallest unused number, case-insensitive across live cards. */
export async function nextCode(tx: Queryable, brandId: string, type: 'MENU' | 'SUB'): Promise<string> {
  const b = await tx.query('SELECT code FROM brand WHERE id = $1', [brandId]);
  const prefix = `${b.rows[0]?.code ?? 'GEN'}-${type === 'SUB' ? 'SR' : 'MN'}-`;
  const { rows } = await tx.query('SELECT upper(code) AS code FROM recipe WHERE deleted_at IS NULL AND code ILIKE $1', [
    prefix.replace(/[\\%_]/g, '\\$&') + '%',
  ]);
  const used = new Set(rows.map((r) => String(r.code)));
  let n = 1;
  while (used.has(`${prefix.toUpperCase()}${String(n).padStart(4, '0')}`)) n++;
  return `${prefix}${String(n).padStart(4, '0')}`;
}

export const isAutoCode = (c: string) => /^[A-Z]{2,4}-(MN|SR)-\d{4}$/i.test(c || '');

async function assertCodeFree(tx: Queryable, code: string, exceptId?: string): Promise<void> {
  const r = await tx.query(
    'SELECT code FROM recipe WHERE deleted_at IS NULL AND lower(code) = lower($1) AND id IS DISTINCT FROM $2',
    [code, exceptId ?? null],
  );
  if (r.rows[0]) throw new ApiError('conflict', `The code ${r.rows[0].code} is already used by another card`);
  const i = await tx.query('SELECT code FROM ingredient WHERE lower(code) = lower($1)', [code]);
  if (i.rows[0]) throw new ApiError('conflict', `The code ${i.rows[0].code} is already used by an ingredient`);
}

/** D-97: blank ingredient rows on a new card. */
const NEW_CARD_ROWS = 6;

export async function createRecipe(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  input: { brandId: string; type: 'MENU' | 'SUB'; name?: string; category?: string },
): Promise<string> {
  need(user, 'recipe.create');
  assertBrandVisible(scope, input.brandId);
  await tx.query('SELECT pg_advisory_xact_lock($1)', [GRAPH_LOCK]); // code allocation is serialised with saves
  const code = await nextCode(tx, input.brandId, input.type);
  await assertCodeFree(tx, code);
  const { rows } = await tx.query(
    `INSERT INTO recipe (code, name, category, type, brand_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [code, input.name || 'New Recipe', input.category ?? '', input.type, input.brandId],
  );
  const id = rows[0]!.id as string;
  // D-97: a new card starts with 6 blank rows (they are already how an empty card is stored; costing, print and export skip them)
  await tx.query(
    `INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit, y, yp)
     SELECT $1, o, '', 0, 'Gram', 1, NULL FROM generate_series(0, $2::int - 1) AS o`,
    [id, NEW_CARD_ROWS],
  );
  await tx.query(`INSERT INTO recipe_method_step (recipe_id, step_number, text) VALUES ($1,1,'')`, [id]);
  await appendAudit(tx, user, 'Created card', `${code} – ${input.name || 'New Recipe'}`);
  return id;
}

/** Codes a NEW or CHANGED line may point at: ingredients visible to the scope, or SUB cards of a visible brand. */
async function assertLineCodesAllowed(tx: Queryable, scope: BrandScope, codes: string[]): Promise<void> {
  if (!codes.length) return;
  const brands = [...scope.brandIds];
  const items = await tx.query(
    `SELECT i.code FROM ingredient i WHERE i.code = ANY($1::text[])
       AND (NOT EXISTS (SELECT 1 FROM item_brand_scope s WHERE s.ingredient_id = i.id)
         OR EXISTS (SELECT 1 FROM item_brand_scope s WHERE s.ingredient_id = i.id AND s.brand_id = ANY($2::text[])))`,
    [codes, brands],
  );
  const subs = await tx.query(
    `SELECT code FROM recipe WHERE code = ANY($1::text[]) AND type = 'SUB' AND deleted_at IS NULL AND brand_id = ANY($2::text[])`,
    [codes, brands],
  );
  const ok = new Set([...items.rows, ...subs.rows].map((r) => String(r.code)));
  const bad = codes.filter((c) => !ok.has(c));
  if (bad.length)
    throw new ApiError('unprocessable', `Unknown or unavailable ingredient code: ${bad.slice(0, 5).join(', ')}`, {
      codes: bad,
    });
}

async function graphWith(
  tx: Queryable,
  candidate: GraphRecipe,
  previousCode: string,
  rename?: { from: string; to: string },
) {
  const { rows } = await tx.query(
    `SELECT r.code, coalesce(array_agg(l.code) FILTER (WHERE l.code IS NOT NULL AND l.code <> ''), '{}') AS lines
       FROM recipe r LEFT JOIN recipe_line l ON l.recipe_id = r.id
      WHERE r.deleted_at IS NULL GROUP BY r.id, r.code`,
  );
  const all: GraphRecipe[] = rows.map((r) => ({
    code: r.code as string,
    lines: (r.lines as string[]).map((c) => ({ code: rename && c === rename.from ? rename.to : c })),
  }));
  assertAcyclicWith(all, candidate, previousCode);
}

/** What a line is saved as (D-70): while any stage is set `y` is their product, otherwise the line's own yield. */
const lineY = (l: LineIn): number => normY(stagedYield(l) ?? l.y);

const sameLines = (
  a: {
    code: string;
    qty: number;
    unit: string;
    y: number;
    yp: number | null;
    yThaw: number | null;
    yCut: number | null;
    yCook: number | null;
  }[],
  b: LineIn[],
) =>
  a.length === b.length &&
  a.every((l, i) => {
    const n = b[i]!;
    return (
      l.code === n.code &&
      l.qty === n.qty &&
      l.unit === n.unit &&
      l.y === lineY(n) &&
      l.yp === n.yp &&
      l.yThaw === (n.yThaw ?? null) &&
      l.yCut === (n.yCut ?? null) &&
      l.yCook === (n.yCook ?? null)
    );
  });

export interface SaveResult {
  changed: boolean;
  fields: string[];
}

/**
 * Save a card (PATCH semantics: only the supplied fields change). Order: lock → version → field-level permission →
 * brand/code rules → line rules → cycle check (advisory lock) → write → audit. Everything in the caller's transaction.
 */
export async function saveRecipe(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  id: string,
  input: RecipeSaveIn,
): Promise<SaveResult> {
  return (await saveCore(tx, user, scope, id, input, false)).result;
}

/**
 * saveRecipe + the editor payload in the same round trips: when only scalar fields / the method changed (lines and code
 * untouched), the new card and its cost view are built from the rows the save already loaded plus the version and
 * updated_at the UPDATE returned, with no re-read. Lines or code changes (the cost closure itself can change, rename
 * cascades) fall back to recipeDetail() after the write.
 */
export async function saveRecipeWithDetail(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  id: string,
  input: RecipeSaveIn,
): Promise<{ result: SaveResult; detail: RecipeDetail }> {
  const out = await saveCore(tx, user, scope, id, input, true);
  return { result: out.result, detail: out.detail ?? (await recipeDetail(tx, scope, id)) };
}

async function saveCore(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  id: string,
  input: RecipeSaveIn,
  withDetail: boolean,
): Promise<{ result: SaveResult; detail?: RecipeDetail }> {
  const { recipe: stored, head, closure } = await loadForSave(tx, scope, id, withDetail);
  const oldLines = stored.lines;
  const oldMethod = stored.method;
  if (head.status === 'LOCKED')
    throw new ApiError('unprocessable', 'That card is approved and locked – unlock it first');
  if (head.version !== input.version)
    throw new ApiError('conflict', 'This card was changed by someone else – reload it', {
      currentVersion: head.version,
    });

  const fields: string[] = [];
  const set: Record<string, unknown> = {};
  const change = <T>(key: keyof Head, col: string, v: T | undefined) => {
    if (v === undefined || v === head[key]) return;
    set[col] = v;
    fields.push(String(key));
  };
  change('name', 'name', input.name);
  change('category', 'category', input.category);
  // D-97: a Sub-Recipe shows "Subrecipe" (derived from the type), so it never keeps a Dry/Raw class
  change('stockClass', 'stock_class', (input.type ?? head.type) === 'SUB' ? null : input.stockClass);
  change('type', 'type', input.type);
  change('brandId', 'brand_id', input.brandId);
  change('output', 'output', input.output);
  change('subQty', 'sub_qty', input.subQty);
  change('subUom', 'sub_uom', input.subUom);
  change('batchOut', 'batch_out', input.batchOut);
  change('batchUom', 'batch_uom', input.batchUom);
  change('buffer', 'buffer', input.buffer);
  const priceChanged = input.sellingPrice !== undefined && input.sellingPrice !== head.sellingPrice;
  if (priceChanged) {
    set['selling_price'] = input.sellingPrice;
    fields.push('sellingPrice');
  }
  // legacy setBrand / setF('type') / regenCode: an auto-numbered code is re-allocated when the brand or type changes
  let wantedCode = input.code;
  const brandOrTypeChanged =
    (input.brandId !== undefined && input.brandId !== head.brandId) ||
    (input.type !== undefined && input.type !== head.type);
  let graphLocked = false;
  if (wantedCode === undefined && (input.regenCode || (brandOrTypeChanged && isAutoCode(head.code)))) {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [GRAPH_LOCK]);
    graphLocked = true;
    wantedCode = await nextCode(tx, input.brandId ?? head.brandId, input.type ?? head.type);
  }
  const codeChanged = wantedCode !== undefined && wantedCode !== head.code;
  if (codeChanged) fields.push('code');
  const linesIn = input.lines?.map((l) => ({ ...l, y: lineY(l) }));
  const linesChanged = linesIn !== undefined && !sameLines(oldLines, linesIn);
  if (linesChanged) fields.push('lines');
  const methodChanged = input.method !== undefined && JSON.stringify(input.method) !== JSON.stringify(oldMethod);
  if (methodChanged) fields.push('method');

  /** The editor payload from what this save already loaded (no re-read): only valid while lines and code are untouched. */
  const detailFromLoaded = (over: Partial<RecipeDto>): RecipeDetail | undefined => {
    if (!withDetail || !closure || linesChanged || codeChanged) return undefined;
    const next: RecipeDto = { ...stored, ...over };
    const codes = [...new Set(next.lines.map((l) => l.code).filter(Boolean))];
    const { catalog, packaging } = parseClosure(closure, codes, toCostRecipe(next));
    return detailFrom(next, catalog, packaging);
  };

  if (!fields.length) return { result: { changed: false, fields }, detail: detailFromLoaded({}) };

  // field-level authorisation: price needs recipe.price; everything else needs recipe.edit
  if (priceChanged) need(user, 'recipe.price', 'Only Cost Control or management can set the selling price');
  if (fields.some((f) => f !== 'sellingPrice')) need(user, 'recipe.edit');

  if (input.brandId !== undefined && input.brandId !== head.brandId) {
    if (!canSeeBrand(scope, input.brandId)) throw new ApiError('forbidden', 'You have no access to that brand');
  }

  // The graph/code lock (D-34) serialises code allocation, line-code checks and the cycle check. Edits that touch none of
  // them (name, category, output, batch, buffer, price, method) are already serialised per card by the row lock.
  if (!graphLocked && (linesChanged || codeChanged || brandOrTypeChanged)) {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [GRAPH_LOCK]);
    graphLocked = true;
  }
  const newCode = codeChanged ? (wantedCode as string) : head.code;
  let renamedRefs = 0;
  if (codeChanged) {
    await assertCodeFree(tx, newCode, id);
    set['code'] = newCode;
  }

  if (linesChanged) {
    const oldSet = new Set(oldLines.map((l) => l.code));
    const fresh = [...new Set(linesIn!.map((l) => l.code).filter((c) => c && !oldSet.has(c)))];
    await assertLineCodesAllowed(tx, scope, fresh);
  }
  if (linesChanged || codeChanged) {
    const finalLines = linesChanged ? linesIn! : oldLines;
    try {
      await graphWith(
        tx,
        { code: newCode, lines: finalLines.map((l) => ({ code: l.code })) },
        head.code,
        codeChanged ? { from: head.code, to: newCode } : undefined,
      );
    } catch (e) {
      if (e instanceof CycleError)
        throw new ApiError('conflict', `That would create a circular recipe: ${e.path.join(' → ')}`, { path: e.path });
      throw e;
    }
  }

  if (codeChanged) {
    // D-33: rename cascades to every reference, in this transaction
    const a = await tx.query('UPDATE recipe_line SET code = $2 WHERE code = $1 AND recipe_id <> $3', [
      head.code,
      newCode,
      id,
    ]);
    const b = await tx.query(`UPDATE menu_cell SET code = $2 WHERE kind = 'RECIPE' AND code = $1`, [
      head.code,
      newCode,
    ]);
    let c = 0;
    try {
      c =
        (await tx.query('UPDATE production_entry SET recipe_code = $2 WHERE recipe_code = $1', [head.code, newCode]))
          .rowCount ?? 0;
    } catch {
      throw new ApiError('conflict', `Production figures already exist under ${newCode}`);
    }
    renamedRefs = (a.rowCount ?? 0) + (b.rowCount ?? 0) + c;
  }

  // audit rows: legacy actions kept, plus D-15 'Edited card' (collapsed per user/card/10 min so autosave is not noise)
  const label = `${newCode}`;
  const audit: AuditEntry[] = [];
  if (priceChanged)
    audit.push({
      action: 'Changed sales price',
      detail: `${label}: ${money(head.sellingPrice)} → ${money(input.sellingPrice)}`,
    });
  if (linesChanged) {
    const ypChanged = linesIn!.some(
      (l, i) =>
        oldLines[i] &&
        l.code === oldLines[i]!.code &&
        (l.yp !== oldLines[i]!.yp ||
          (l.yThaw ?? null) !== oldLines[i]!.yThaw ||
          (l.yCut ?? null) !== oldLines[i]!.yCut ||
          (l.yCook ?? null) !== oldLines[i]!.yCook),
    );
    if (ypChanged)
      audit.push({
        action: 'Changed a line yield',
        detail: `Yield changed on a line of ${label}. Other lines keep theirs.`,
      });
  }
  if (codeChanged)
    audit.push({
      action: 'Renamed card code',
      detail: `${head.code} → ${newCode} (${renamedRefs} reference${renamedRefs === 1 ? '' : 's'} updated)`,
    });
  const other = fields.filter((f) => f !== 'sellingPrice' && f !== 'code');
  if (other.length)
    audit.push({
      action: 'Edited card',
      detail: `${label} – ${input.name ?? head.name} (${other.join(', ')})`,
      recentLike: label.replace(/[\\%_]/g, '\\$&') + ' %',
    });

  // ONE statement: the version-checked UPDATE and the audit rows (a data-modifying CTE runs regardless of being read, and
  // both roll back together). Zero rows updated = someone else got in between: 409, which also discards the audit rows.
  const cols = Object.keys(set);
  const vals = cols.map((k) => set[k]);
  const au = audit.length ? auditInsertSql(user, audit, 3 + vals.length) : null;
  const upd = await tx.query<{ version: number; updated_at: Date }>(
    `WITH u AS (
       UPDATE recipe SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}${cols.length ? ', ' : ''}version = version + 1
        WHERE id = $1 AND version = $2
        RETURNING version, updated_at)${au ? `, a AS (${au.sql})` : ''}
     SELECT version, updated_at FROM u`,
    [id, input.version, ...vals, ...(au ? au.params : [])],
  );
  if (!upd.rows[0]) throw new ApiError('conflict', 'This card was changed by someone else – reload it');

  if (linesChanged) {
    await tx.query('DELETE FROM recipe_line WHERE recipe_id = $1', [id]);
    const L = linesIn!;
    if (L.length)
      await tx.query(
        `INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit, y, yp, y_thaw, y_cut, y_cook)
         SELECT $1, o, c, q, u, y, yp, yt, yc, yk FROM unnest($2::int[], $3::text[], $4::float8[], $5::text[], $6::float8[], $7::float8[], $8::float8[], $9::float8[], $10::float8[]) AS t(o,c,q,u,y,yp,yt,yc,yk)`,
        [
          id,
          L.map((_, i) => i),
          L.map((l) => l.code),
          L.map((l) => l.qty),
          L.map((l) => l.unit),
          L.map((l) => l.y),
          L.map((l) => l.yp),
          L.map((l) => l.yThaw ?? null),
          L.map((l) => l.yCut ?? null),
          L.map((l) => l.yCook ?? null),
        ],
      );
  }
  if (methodChanged) {
    await tx.query('DELETE FROM recipe_method_step WHERE recipe_id = $1', [id]);
    const M = input.method!;
    if (M.length)
      await tx.query(
        `INSERT INTO recipe_method_step (recipe_id, step_number, text) SELECT $1, n, t FROM unnest($2::int[], $3::text[]) AS x(n,t)`,
        [id, M.map((_, i) => i + 1), M],
      );
  }

  const scalar: Partial<RecipeDto> = {};
  for (const [col, v] of Object.entries(set)) (scalar as Record<string, unknown>)[DTO_KEY[col] ?? col] = v;
  const over: Partial<RecipeDto> = {
    ...scalar,
    version: upd.rows[0].version,
    updatedAt: upd.rows[0].updated_at,
    ...(methodChanged ? { method: input.method! } : {}),
  };
  return { result: { changed: true, fields }, detail: detailFromLoaded(over) };
}

/** UPDATE column -> RecipeDto key, for the columns saveRecipe can set (the rest are named the same). */
const DTO_KEY: Record<string, string> = {
  brand_id: 'brandId',
  sub_qty: 'subQty',
  sub_uom: 'subUom',
  batch_out: 'batchOut',
  batch_uom: 'batchUom',
  selling_price: 'sellingPrice',
};

async function loadHeadsByIds(tx: Queryable, scope: BrandScope, ids: string[]): Promise<Head[]> {
  const out: Head[] = [];
  for (const id of [...new Set(ids)].sort()) out.push(await lockHead(tx, scope, id)); // sorted: no deadlocks between bulk calls
  return out;
}

export async function deleteRecipes(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  ids: string[],
): Promise<string[]> {
  need(user, 'recipe.delete');
  const heads = await loadHeadsByIds(tx, scope, ids);
  if (heads.some((h) => h.status === 'LOCKED'))
    need(user, 'recipe.unlock', 'The selection includes approved cards – your role cannot delete those');
  await tx.query(
    'UPDATE recipe SET deleted_at = now(), deleted_by = $2, version = version + 1 WHERE id = ANY($1::text[])',
    [heads.map((h) => h.id), user.name],
  );
  await appendAudit(
    tx,
    user,
    heads.length > 1 ? 'Deleted cards' : 'Deleted card',
    heads.map((h) => h.code || h.name).join(', '),
  );
  return heads.map((h) => h.id);
}

export async function restoreRecipes(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  ids: string[],
): Promise<string[]> {
  need(user, 'recipe.delete');
  const restored: { id: string; code: string; name: string }[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const { rows } = await tx.query(
      'SELECT id, code, name, brand_id FROM recipe WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE',
      [id],
    );
    const r = rows[0];
    if (!r || !canSeeBrand(scope, r.brand_id)) throw new ApiError('not_found', 'Not found');
    await assertCodeFree(tx, r.code as string, id); // another card may have taken the code meanwhile
    await tx.query('UPDATE recipe SET deleted_at = NULL, deleted_by = NULL, version = version + 1 WHERE id = $1', [id]);
    restored.push({ id, code: r.code, name: r.name });
  }
  await appendAudit(
    tx,
    user,
    restored.length > 1 ? 'Restored cards' : 'Restored card',
    restored.map((r) => r.code).join(', '),
  );
  return restored.map((r) => r.id);
}

export async function duplicateRecipe(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  id: string,
): Promise<string> {
  need(user, 'recipe.create');
  const src = await getRecipe(tx, scope, id); // 404 when out of scope
  await tx.query('SELECT pg_advisory_xact_lock($1)', [GRAPH_LOCK]);
  const code = await nextCode(tx, src.brandId, src.type);
  await assertCodeFree(tx, code);
  const { rows } = await tx.query(
    `INSERT INTO recipe (code, name, category, type, brand_id, output, sub_qty, sub_uom, batch_out, batch_uom, selling_price, buffer, stock_class)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [
      code,
      `${src.name} (copy)`,
      src.category,
      src.type,
      src.brandId,
      src.output,
      src.subQty,
      src.subUom,
      src.batchOut,
      src.batchUom,
      src.sellingPrice,
      src.buffer,
      src.type === 'SUB' ? null : src.stockClass,
    ],
  );
  const nid = rows[0]!.id as string;
  await tx.query(
    `INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit, y, yp, y_thaw, y_cut, y_cook)
     SELECT $2, sort_order, code, qty, unit, y, yp, y_thaw, y_cut, y_cook FROM recipe_line WHERE recipe_id = $1`,
    [id, nid],
  );
  await tx.query(
    `INSERT INTO recipe_method_step (recipe_id, step_number, text) SELECT $2, step_number, text FROM recipe_method_step WHERE recipe_id = $1`,
    [id, nid],
  );
  await tx.query(
    `INSERT INTO recipe_photo (recipe_id, content_type, data, size, width, height, sha256)
     SELECT $2, content_type, data, size, width, height, sha256 FROM recipe_photo WHERE recipe_id = $1`,
    [id, nid],
  );
  await appendAudit(tx, user, 'Duplicated card', `${src.code} → ${code}`);
  return nid;
}

const LOCK_BLOCKERS = new Set(['no-price', 'missing-conversion']);

/** D-29: lock gate. Returns the cost-at-lock snapshot (D-26). */
async function lockOne(
  tx: Queryable,
  user: SessionUser,
  head: Head,
  who: string,
  overrideReason: string | undefined,
  catalog: Catalog,
): Promise<void> {
  const lines = (
    await tx.query('SELECT code, qty, unit, y, yp FROM recipe_line WHERE recipe_id = $1 ORDER BY sort_order', [head.id])
  ).rows as RecipeDto['lines'];
  const rec = toCostRecipe({ ...head, lines } as unknown as RecipeDto);
  const c = costWithIssues(rec, catalog.context);
  const blockers = c.issues.filter((i) => LOCK_BLOCKERS.has(i.kind));
  if (blockers.length) {
    if (!overrideReason || user.role !== 'gm')
      throw new ApiError(
        'unprocessable',
        `${head.code} has ${blockers.length} line problem(s) (missing price or unit conversion) and cannot be locked`,
        {
          issues: blockers.slice(0, 20),
          overridable: user.role === 'gm',
        },
      );
  }
  const st = catalog.settings;
  const snapshot = {
    food: c.food,
    totalCost: c.totalCost,
    sellingPrice: c.sp,
    fcPct: c.fcPct,
    complete: c.complete,
    settings: {
      currency: st.currency,
      pkg: st.pkg,
      del: st.del,
      lab: st.lab,
      ops: st.ops,
      buffer: st.buffer,
      target: st.target,
      vat: st.vat,
    },
    priceDate: st.priceDate,
    ...(blockers.length && overrideReason ? { overrideReason } : {}),
  };
  const res = await tx.query(
    `UPDATE recipe SET status = 'LOCKED', locked_by = $2, locked_at = now(), locked_by_user_id = $3, cost_at_lock = $4::jsonb, version = version + 1
      WHERE id = $1 AND status = 'DRAFT'`,
    [head.id, who, user.id, JSON.stringify(snapshot)],
  );
  if (res.rowCount === 0) throw new ApiError('conflict', 'That card was just locked by someone else');
  await tx.query(`INSERT INTO recipe_history_entry (recipe_id, action, who, user_id) VALUES ($1,'LOCK',$2,$3)`, [
    head.id,
    who,
    user.id,
  ]);
}

export async function lockRecipes(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  ids: string[],
  approvedBy: string,
  overrideReason?: string,
): Promise<void> {
  need(user, 'recipe.lock', 'Your access level cannot approve recipe cards');
  const who = approvedBy.trim();
  if (!who) throw new ApiError('bad_request', 'Enter who is approving this');
  const heads = await loadHeadsByIds(tx, scope, ids);
  const todo = heads.filter((h) => h.status === 'DRAFT');
  if (!todo.length) throw new ApiError('unprocessable', 'Nothing selected is unlocked');
  const catalog = await loadCatalog(tx); // once for the whole batch
  for (const h of todo) await lockOne(tx, user, h, who, overrideReason, catalog);
  if (todo.length === 1) {
    const h = todo[0]!;
    await appendAudit(
      tx,
      user,
      'Locked card',
      `${h.code} – ${h.name} (approved by ${who})${overrideReason ? ` [override: ${overrideReason}]` : ''}`,
    );
  } else await appendAudit(tx, user, 'Locked cards', `${todo.length} cards (approved by ${who})`);
}

export async function unlockRecipes(tx: Queryable, user: SessionUser, scope: BrandScope, ids: string[]): Promise<void> {
  need(user, 'recipe.unlock', 'Only a Cost Controller or General Manager can reopen an approved card');
  const heads = await loadHeadsByIds(tx, scope, ids);
  const todo = heads.filter((h) => h.status === 'LOCKED');
  if (!todo.length) throw new ApiError('unprocessable', 'Nothing selected is locked');
  await tx.query(
    `UPDATE recipe SET status = 'DRAFT', locked_by = NULL, locked_at = NULL, locked_by_user_id = NULL, version = version + 1 WHERE id = ANY($1::text[])`,
    [todo.map((h) => h.id)],
  );
  for (const h of todo)
    await tx.query(`INSERT INTO recipe_history_entry (recipe_id, action, who, user_id) VALUES ($1,'UNLOCK',$2,$3)`, [
      h.id,
      user.name,
      user.id,
    ]);
  if (todo.length === 1) await appendAudit(tx, user, 'Unlocked card', `${todo[0]!.code} – ${todo[0]!.name}`);
  else await appendAudit(tx, user, 'Unlocked cards', `${todo.length} cards`);
}

/** Guard used by the photo routes: card in scope, DRAFT (422 when locked). Returns the head and holds the row lock. */
export async function assertEditableCard(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  id: string,
): Promise<{ id: string; code: string; name: string }> {
  need(user, 'recipe.edit');
  const h = await lockHead(tx, scope, id);
  if (h.status === 'LOCKED') throw new ApiError('unprocessable', 'That card is approved and locked – unlock it first');
  return { id: h.id, code: h.code, name: h.name };
}

/** Legacy confirmDelete warning: other (visible) live cards whose lines still use the codes of `ids`. */
export async function recipeReferences(
  db: Queryable,
  scope: BrandScope,
  ids: string[],
): Promise<{ lines: number; cards: string[]; codes: string[] }> {
  const own = await db.query(
    'SELECT code FROM recipe WHERE id = ANY($1::text[]) AND deleted_at IS NULL AND brand_id = ANY($2::text[])',
    [ids, [...scope.brandIds]],
  );
  const codes = own.rows.map((r) => String(r.code)).filter(Boolean);
  if (!codes.length) return { lines: 0, cards: [], codes: [] };
  const { rows } = await db.query(
    `SELECT r.name, l.code FROM recipe_line l JOIN recipe r ON r.id = l.recipe_id AND r.deleted_at IS NULL
      WHERE l.code = ANY($1::text[]) AND NOT (r.id = ANY($2::text[])) AND r.brand_id = ANY($3::text[])`,
    [codes, ids, [...scope.brandIds]],
  );
  return {
    lines: rows.length,
    cards: [...new Set(rows.map((r) => String(r.name)))],
    codes: [...new Set(rows.map((r) => String(r.code)))],
  };
}
