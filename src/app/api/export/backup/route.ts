import { z } from 'zod';
import { ApiError } from '@/lib/errors';
import { withAuth } from '@/lib/auth/with-auth';
import { inTx, withScope } from '@/lib/api';
import { parseQuery } from '@/lib/http';
import { auditExport } from '@/lib/services/audit';
import { buildBackupCore, buildImageChunk, buildStockChunk } from '@/lib/services/backup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const query = z.object({
  part: z.enum(['core', 'photos', 'logos', 'counts', 'receipts']).default('core'),
  /** counts / receipts: the first day to include (the file's stockFrom) */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

/** Backup in parts so no response exceeds the platform limit: `core` (all data), then `photos` / `logos` chunks. Needs data.admin. */
export const GET = withAuth({ perm: 'data.admin' }, async (req, { user }) => {
  const q = parseQuery(req, query);
  if (q.part === 'core') {
    const core = await withScope(user, (db) => buildBackupCore(db, user));
    await inTx(user, (tx) => auditExport(tx, user, 'full backup', core.recipes.length + core.ingredients.length));
    return Response.json(core, { headers: { 'cache-control': 'private, no-store' } });
  }
  if (q.part === 'counts' || q.part === 'receipts') {
    const part = q.part;
    const from = q.from;
    if (!from) throw new ApiError('bad_request', 'from is required');
    return Response.json(await withScope(user, (db) => buildStockChunk(db, user, part, from, q.offset)), {
      headers: { 'cache-control': 'private, no-store' },
    });
  }
  return Response.json(
    await withScope(user, (db) => buildImageChunk(db, user, q.part as 'photos' | 'logos', q.offset)),
    { headers: { 'cache-control': 'private, no-store' } },
  );
});
