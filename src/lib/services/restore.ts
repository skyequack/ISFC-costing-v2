import { z } from 'zod';
import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { ApiError } from '../errors';
import { can } from '../permissions';
import { applyRestore, backupSchema, type RestoreStats } from './backup';

export const CHUNK_MAX = 1_500_000;
export const MAX_CHUNKS = 120; // ~180 MB of JSON, far beyond any real backup
const sessionId = z.string().regex(/^[A-Za-z0-9-]{16,64}$/);

export const chunkIn = z.object({
  session: sessionId,
  seq: z
    .number()
    .int()
    .min(0)
    .max(MAX_CHUNKS - 1),
  data: z.string().min(1).max(CHUNK_MAX),
});
export const restoreIn = z.object({
  session: sessionId,
  total: z.number().int().min(1).max(MAX_CHUNKS),
  file: z.string().trim().max(200).default('backup.json'),
});

function needAdmin(user: SessionUser): void {
  if (!can(user.role, 'data.admin')) throw new ApiError('forbidden', 'Only the General Manager can do that');
}

export async function storeChunk(tx: Queryable, user: SessionUser, c: z.output<typeof chunkIn>): Promise<void> {
  needAdmin(user);
  if (c.seq === 0) await tx.query(`DELETE FROM restore_chunk WHERE created_at < now() - interval '1 day'`); // prune abandoned uploads
  const owner = await tx.query('SELECT user_id FROM restore_chunk WHERE session_id = $1 LIMIT 1', [c.session]);
  if (owner.rows[0] && owner.rows[0].user_id !== user.id)
    throw new ApiError('forbidden', 'That upload belongs to someone else');
  await tx.query(
    `INSERT INTO restore_chunk (session_id, seq, data, user_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (session_id, seq) DO UPDATE SET data = EXCLUDED.data`,
    [c.session, c.seq, c.data, user.id],
  );
}

async function assemble(tx: Queryable, user: SessionUser, session: string, total: number): Promise<unknown> {
  const { rows } = await tx.query('SELECT seq, data, user_id FROM restore_chunk WHERE session_id = $1 ORDER BY seq', [
    session,
  ]);
  if (rows.length !== total || rows.some((r, i) => r.seq !== i))
    throw new ApiError('bad_request', 'The upload is incomplete - try again');
  if (rows.some((r) => r.user_id !== user.id)) throw new ApiError('forbidden', 'That upload belongs to someone else');
  try {
    return JSON.parse(rows.map((r) => r.data as string).join(''));
  } catch {
    throw new ApiError('bad_request', 'That file is not a valid backup');
  }
}

class DryRun extends Error {
  constructor(readonly stats: RestoreStats) {
    super('dry-run');
  }
}

/** Dry-run applies the restore for real and rolls back, so every constraint is exercised; commit applies and drops the staging rows. */
export async function runRestore(
  tx: Queryable,
  user: SessionUser,
  p: z.output<typeof restoreIn>,
  mode: 'dry-run' | 'commit',
): Promise<RestoreStats> {
  needAdmin(user);
  const raw = await assemble(tx, user, p.session, p.total);
  const parsed = backupSchema.safeParse(raw);
  if (!parsed.success)
    throw new ApiError('bad_request', 'That file is not a valid ISFC backup', {
      fields: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.slice(0, 4).join('.'), message: i.message })),
    });
  await tx.query('SAVEPOINT restore_try');
  try {
    const stats = await applyRestore(tx, user, parsed.data, p.file);
    if (mode === 'dry-run') throw new DryRun(stats);
    await tx.query('DELETE FROM restore_chunk WHERE session_id = $1', [p.session]);
    return stats;
  } catch (e) {
    await tx.query('ROLLBACK TO SAVEPOINT restore_try');
    if (e instanceof DryRun) return e.stats;
    throw e;
  }
}
