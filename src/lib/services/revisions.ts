import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { appendAudit } from '../db/repo/audit';
import { canSeeBrand, type BrandScope } from '../db/scope';
import { TODAY_SQL } from '../business-day';
import { ApiError } from '../errors';
import { can } from '../permissions';
import { CODE_LOCK } from './ingredients';

/**
 * Card revisions (D-100). `recipe` is always the revision in force today; this module archives the state it had before a new
 * revision starts. A revision starts the day it is saved (business day, no backdating), so a second change on the same day is
 * merged into that day's revision (an archived range from = to would be empty).
 */
export const MAX_REVISIONS = 50;

export type RevisionOrigin = 'BUTTON' | 'UPLOAD' | 'UNLOCK';

export interface RevisionSummary {
  revision: number;
  /** YYYY-MM-DD, first day this revision was in force */
  effectiveFrom: string;
  /** YYYY-MM-DD, the day the next revision started; null = the revision in force now */
  effectiveTo: string | null;
  status: 'DRAFT' | 'LOCKED';
  name: string;
  lockedBy: string | null;
  createdBy: string | null;
  /** what ended it: button, upload or unlock; null for the current revision */
  origin: RevisionOrigin | null;
  nLines: number;
}

export interface RevisionDetail extends RevisionSummary {
  category: string;
  stockClass: 'Dry' | 'Raw' | null;
  type: 'MENU' | 'SUB';
  output: number;
  sellingPrice: number;
  buffer: number | null;
  batchOut: number;
  batchUom: string;
  lines: {
    sortOrder: number;
    code: string;
    qty: number;
    unit: string;
    y: number;
    yp: number | null;
    yThaw: number | null;
    yCut: number | null;
    yCook: number | null;
  }[];
  method: string[];
}

/**
 * Archives the card's present state as its revision N and makes the live row revision N + 1 starting today. The caller holds
 * the card's row lock (FOR UPDATE) and is about to change it. Returns false, and changes nothing, when the present revision
 * started today (it is then edited in place). Takes the graph lock so the rename cascade (D-33) cannot interleave with the
 * copy of the lines.
 */
export async function archiveRevision(
  tx: Queryable,
  user: SessionUser,
  recipeId: string,
  origin: RevisionOrigin,
): Promise<boolean> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [CODE_LOCK]);
  const cur = (
    await tx.query(
      `SELECT revision, effective_from::text AS from_day, ${TODAY_SQL}::text AS today,
              (SELECT count(*)::int FROM recipe_version v WHERE v.recipe_id = $1) AS n
         FROM recipe WHERE id = $1`,
      [recipeId],
    )
  ).rows[0];
  if (!cur) throw new ApiError('not_found', 'Not found');
  if ((cur.from_day as string) >= (cur.today as string)) return false;
  if ((cur.n as number) >= MAX_REVISIONS)
    throw new ApiError('unprocessable', `A card can have at most ${MAX_REVISIONS} revisions`);
  const ins = await tx.query(
    `INSERT INTO recipe_version (recipe_id, revision, effective_from, effective_to, name, category, stock_class, type, brand_id,
                                 output, sub_qty, sub_uom, batch_out, batch_uom, selling_price, buffer, status, locked_by,
                                 locked_at, locked_by_user_id, cost_at_lock, method, origin, created_by, created_by_user_id)
     SELECT r.id, r.revision, r.effective_from, ${TODAY_SQL}, r.name, r.category, r.stock_class, r.type, r.brand_id,
            r.output, r.sub_qty, r.sub_uom, r.batch_out, r.batch_uom, r.selling_price, r.buffer, r.status, r.locked_by,
            r.locked_at, r.locked_by_user_id, r.cost_at_lock,
            coalesce((SELECT array_agg(m.text ORDER BY m.step_number) FROM recipe_method_step m WHERE m.recipe_id = r.id), '{}'),
            $2, $3, $4
       FROM recipe r WHERE r.id = $1
     RETURNING id`,
    [recipeId, origin, user.name, user.id],
  );
  await tx.query(
    `INSERT INTO recipe_version_line (version_id, sort_order, code, qty, unit, y, yp, y_thaw, y_cut, y_cook)
     SELECT $2, l.sort_order, l.code, l.qty, l.unit, l.y, l.yp, l.y_thaw, l.y_cut, l.y_cook FROM recipe_line l WHERE l.recipe_id = $1`,
    [recipeId, ins.rows[0]!.id],
  );
  await tx.query(`UPDATE recipe SET revision = revision + 1, effective_from = ${TODAY_SQL} WHERE id = $1`, [recipeId]);
  return true;
}

/** The "Start new revision" button: freeze the card as it is now and start the next revision today. */
export async function startRevision(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  id: string,
  expectedVersion: number,
): Promise<{ revision: number; effectiveFrom: string; version: number }> {
  if (!can(user.role, 'recipe.edit')) throw new ApiError('forbidden', 'Your role cannot do that');
  const { rows } = await tx.query(
    `SELECT id, code, name, brand_id, status, version, revision FROM recipe WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [id],
  );
  const r = rows[0];
  if (!r || !canSeeBrand(scope, r.brand_id as string)) throw new ApiError('not_found', 'Not found');
  if (r.status === 'LOCKED') throw new ApiError('unprocessable', 'That card is approved and locked – unlock it first');
  if (r.version !== expectedVersion)
    throw new ApiError('conflict', 'This card was changed by someone else – reload it', {
      currentVersion: r.version,
    });
  if (!(await archiveRevision(tx, user, id, 'BUTTON')))
    throw new ApiError('conflict', 'A revision already started today – keep editing it');
  const upd = await tx.query(
    `UPDATE recipe SET version = version + 1 WHERE id = $1 RETURNING version, revision, effective_from::text AS from_day`,
    [id],
  );
  const u = upd.rows[0]!;
  await appendAudit(
    tx,
    user,
    'Started card revision',
    `${r.code}: revision ${u.revision - 1} → ${u.revision} from ${u.from_day} (button)`,
  );
  return { revision: u.revision as number, effectiveFrom: u.from_day as string, version: u.version as number };
}

async function visibleCard(db: Queryable, scope: BrandScope, id: string) {
  const { rows } = await db.query(
    `SELECT id, brand_id, name, status, locked_by, revision, effective_from::text AS from_day,
            (SELECT count(*)::int FROM recipe_line l WHERE l.recipe_id = recipe.id AND l.code <> '') AS n_lines
       FROM recipe WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  const r = rows[0];
  if (!r || !canSeeBrand(scope, r.brand_id as string)) throw new ApiError('not_found', 'Not found');
  return r;
}

/** Newest first; the first entry is the revision in force now. Out of scope or unknown card: 404. */
export async function listRevisions(db: Queryable, scope: BrandScope, id: string): Promise<RevisionSummary[]> {
  const c = await visibleCard(db, scope, id);
  const { rows } = await db.query(
    `SELECT v.revision, v.effective_from::text AS from_day, v.effective_to::text AS to_day, v.status, v.name, v.locked_by,
            v.created_by, v.origin,
            (SELECT count(*)::int FROM recipe_version_line l WHERE l.version_id = v.id AND l.code <> '') AS n_lines
       FROM recipe_version v WHERE v.recipe_id = $1 ORDER BY v.revision DESC`,
    [id],
  );
  return [
    {
      revision: c.revision as number,
      effectiveFrom: c.from_day as string,
      effectiveTo: null,
      status: c.status as 'DRAFT' | 'LOCKED',
      name: c.name as string,
      lockedBy: (c.locked_by as string | null) ?? null,
      createdBy: null,
      origin: null,
      nLines: c.n_lines as number,
    },
    ...rows.map((v) => ({
      revision: v.revision as number,
      effectiveFrom: v.from_day as string,
      effectiveTo: v.to_day as string,
      status: v.status as 'DRAFT' | 'LOCKED',
      name: v.name as string,
      lockedBy: (v.locked_by as string | null) ?? null,
      createdBy: v.created_by as string,
      origin: v.origin as RevisionOrigin,
      nLines: v.n_lines as number,
    })),
  ];
}

/** One archived revision with its lines and method. The current revision is the card itself (404 here). */
export async function getRevision(db: Queryable, scope: BrandScope, id: string, n: number): Promise<RevisionDetail> {
  await visibleCard(db, scope, id);
  const { rows } = await db.query(
    `SELECT v.*, v.effective_from::text AS from_day, v.effective_to::text AS to_day
       FROM recipe_version v WHERE v.recipe_id = $1 AND v.revision = $2`,
    [id, n],
  );
  const v = rows[0];
  if (!v) throw new ApiError('not_found', 'Not found');
  const lines = (
    await db.query(
      `SELECT sort_order, code, qty, unit, y, yp, y_thaw, y_cut, y_cook FROM recipe_version_line WHERE version_id = $1 ORDER BY sort_order`,
      [v.id],
    )
  ).rows;
  return {
    revision: v.revision,
    effectiveFrom: v.from_day,
    effectiveTo: v.to_day,
    status: v.status,
    name: v.name,
    lockedBy: v.locked_by ?? null,
    createdBy: v.created_by,
    origin: v.origin,
    nLines: lines.filter((l) => l.code).length,
    category: v.category,
    stockClass: v.stock_class ?? null,
    type: v.type,
    output: v.output,
    sellingPrice: v.selling_price,
    buffer: v.buffer ?? null,
    batchOut: v.batch_out,
    batchUom: v.batch_uom,
    lines: lines.map((l) => ({
      sortOrder: l.sort_order,
      code: l.code,
      qty: l.qty,
      unit: l.unit,
      y: l.y,
      yp: l.yp ?? null,
      yThaw: l.y_thaw ?? null,
      yCut: l.y_cut ?? null,
      yCook: l.y_cook ?? null,
    })),
    method: v.method,
  };
}
