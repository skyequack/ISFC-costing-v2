import type { Queryable } from '../client';
import type { SessionUser } from '../../auth/types';

/**
 * Append one audit row. Always called with the SAME transaction handle as the change it records
 * (docs/ARCHITECTURE.md §2 step 9) so a rollback leaves no audit row. The actor comes from the session,
 * never from a request body. The table is append-only (DB triggers), so there is no update/delete here.
 */
export interface AuditEntry {
  action: string;
  detail: string;
  /** collapse: skipped when this user already has an 'Edited card' row matching `detail LIKE recentLike` in the last 10 minutes */
  recentLike?: string;
}

/**
 * Several audit rows (and the autosave "Edited card" collapse) in ONE statement instead of a SELECT + INSERT per row.
 * Same rules as appendAudit: same transaction handle, actor from the session, rows in the order given.
 */
export async function appendAuditMany(
  tx: Queryable,
  actor: Pick<SessionUser, 'id' | 'name' | 'role'>,
  entries: AuditEntry[],
): Promise<void> {
  if (!entries.length) return;
  await tx.query(
    `INSERT INTO audit_log (user_id, user_name_snapshot, role_snapshot, action, detail)
     SELECT $1::text, $2::text, $3::text, t.action, t.detail
       FROM unnest($4::text[], $5::text[], $6::text[]) WITH ORDINALITY AS t(action, detail, recent_like, ord)
      WHERE t.recent_like IS NULL OR NOT EXISTS (
              SELECT 1 FROM audit_log a
               WHERE a.user_id = $1::text AND a.action = 'Edited card' AND a.detail LIKE t.recent_like
                 AND a.created_at > now() - interval '10 minutes')
      ORDER BY t.ord`,
    [
      actor.id,
      actor.name,
      actor.role,
      entries.map((e) => e.action),
      entries.map((e) => e.detail),
      entries.map((e) => e.recentLike ?? null),
    ],
  );
}

export async function appendAudit(
  tx: Queryable,
  actor: Pick<SessionUser, 'id' | 'name' | 'role'>,
  action: string,
  detail = '',
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (user_id, user_name_snapshot, role_snapshot, action, detail) VALUES ($1,$2,$3,$4,$5)`,
    [actor.id, actor.name, actor.role, action, detail],
  );
}
