import { z } from 'zod';
import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { appendAudit } from '../db/repo/audit';
import { ApiError } from '../errors';
import { can } from '../permissions';

export const auditQuery = z.object({
  q: z.string().max(100).default(''),
  archived: z.enum(['0', '1']).default('0'),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export interface AuditRow {
  id: string;
  at: string;
  user: string;
  role: string;
  action: string;
  detail: string;
}

export const CLEARED = 'Cleared activity log';

/**
 * D-31: entries older than the latest `Cleared activity log` marker are hidden unless archived=1; nothing is deleted.
 * Needs audit.view. Search is over user + action + detail (legacy aq).
 */
export async function listAudit(
  db: Queryable,
  user: SessionUser,
  p: z.output<typeof auditQuery>,
): Promise<{ rows: AuditRow[]; total: number; archivedHidden: number }> {
  if (!can(user.role, 'audit.view')) throw new ApiError('forbidden', 'Your role cannot do that');
  const marker = (await db.query(`SELECT max(created_at) AS t FROM audit_log WHERE action = $1`, [CLEARED])).rows[0]
    ?.t as Date | null;
  const like = '%' + p.q.toLowerCase().replace(/[\\%_]/g, '\\$&') + '%';
  const visibleFrom = p.archived === '1' ? null : marker;
  const where = `($1::timestamptz IS NULL OR created_at >= $1) AND ($2 = '%%' OR lower(user_name_snapshot || ' ' || action || ' ' || detail) LIKE $2)`;
  const total = Number(
    (await db.query(`SELECT count(*) AS n FROM audit_log WHERE ${where}`, [visibleFrom, like])).rows[0]!.n,
  );
  const { rows } = await db.query(
    `SELECT id, created_at, user_name_snapshot, role_snapshot, action, detail FROM audit_log WHERE ${where}
      ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
    [visibleFrom, like, p.limit, p.offset],
  );
  const hidden =
    marker && p.archived !== '1'
      ? Number((await db.query('SELECT count(*) AS n FROM audit_log WHERE created_at < $1', [marker])).rows[0]!.n)
      : 0;
  return {
    total,
    archivedHidden: hidden,
    rows: rows.map((r) => ({
      id: r.id,
      at: (r.created_at as Date).toISOString(),
      user: r.user_name_snapshot,
      role: r.role_snapshot,
      action: r.action,
      detail: r.detail,
    })),
  };
}

/** Legacy "Clear activity log" as an append-only marker (D-31). Needs data.admin. */
export async function archiveAudit(tx: Queryable, user: SessionUser): Promise<void> {
  if (!can(user.role, 'data.admin')) throw new ApiError('forbidden', 'Only the General Manager can do that');
  await appendAudit(
    tx,
    user,
    CLEARED,
    'Older entries are hidden from the Activity Log by default; nothing was deleted',
  );
}

/** D-44: exports write one `Exported data` entry (kind + row count) by the acting user. */
export async function auditExport(tx: Queryable, user: SessionUser, kind: string, rows: number): Promise<void> {
  await appendAudit(tx, user, 'Exported data', `${kind}: ${rows} row${rows === 1 ? '' : 's'}`);
}
