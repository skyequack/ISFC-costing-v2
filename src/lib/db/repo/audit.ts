import type { Queryable } from '../client';
import type { SessionUser } from '../../auth/types';

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
