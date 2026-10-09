import type { Queryable } from '../client';
import type { SessionUser } from '../../auth/types';

export interface AuditEntry {
  action: string;
  detail: string;
  /** collapse: skipped when this user already has an 'Edited card' row matching `detail LIKE recentLike` in the last 10 minutes */
  recentLike?: string;
}

type Actor = Pick<SessionUser, 'id' | 'name' | 'role'>;

/**
 * The INSERT for several audit rows (and the autosave "Edited card" collapse) as one statement, with its 6 parameters
 * numbered from `first`. Usable on its own or as a CTE inside a bigger statement (the card save folds it into its UPDATE).
 */
export function auditInsertSql(actor: Actor, entries: AuditEntry[], first: number): { sql: string; params: unknown[] } {
  const p = (n: number) => `$${first + n}`;
  return {
    sql: `INSERT INTO audit_log (user_id, user_name_snapshot, role_snapshot, action, detail)
     SELECT ${p(0)}::text, ${p(1)}::text, ${p(2)}::text, t.action, t.detail
       FROM unnest(${p(3)}::text[], ${p(4)}::text[], ${p(5)}::text[]) WITH ORDINALITY AS t(action, detail, recent_like, ord)
      WHERE t.recent_like IS NULL OR NOT EXISTS (
              SELECT 1 FROM audit_log a
               WHERE a.user_id = ${p(0)}::text AND a.action = 'Edited card' AND a.detail LIKE t.recent_like
                 AND a.created_at > now() - interval '10 minutes')
      ORDER BY t.ord`,
    params: [
      actor.id,
      actor.name,
      actor.role,
      entries.map((e) => e.action),
      entries.map((e) => e.detail),
      entries.map((e) => e.recentLike ?? null),
    ],
  };
}

/**
 * Several audit rows in ONE statement instead of a SELECT + INSERT per row.
 * Same rules as appendAudit: same transaction handle, actor from the session, rows in the order given.
 */
export async function appendAuditMany(tx: Queryable, actor: Actor, entries: AuditEntry[]): Promise<void> {
  if (!entries.length) return;
  const q = auditInsertSql(actor, entries, 1);
  await tx.query(q.sql, q.params);
}

/**
 * Append one audit row. Always called with the SAME transaction handle as the change it records
 * (docs/ARCHITECTURE.md §2 step 9) so a rollback leaves no audit row. The actor comes from the session,
 * never from a request body. The table is append-only (DB triggers), so there is no update/delete here.
 */
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
