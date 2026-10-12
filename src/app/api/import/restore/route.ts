import { withAuth } from '@/lib/auth/with-auth';
import { bustCatalog, inDirectTx } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { parseJson } from '@/lib/http';
import { restoreIn, runRestore } from '@/lib/services/restore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Apply an uploaded backup (see /chunk). `?mode=dry-run` runs the whole restore and rolls it back, returning the counts;
 * `?mode=commit` applies it in ONE transaction on the direct connection. Needs data.admin; audited `Restored a backup`.
 */
export const POST = withAuth({ perm: 'data.admin', limit: 'restore' }, async (req, { user }) => {
  const mode = new URL(req.url).searchParams.get('mode');
  if (mode !== 'dry-run' && mode !== 'commit') throw new ApiError('bad_request', 'mode must be dry-run or commit');
  const body = await parseJson(req, restoreIn, 10_000);
  const stats = await inDirectTx(user, (tx) => runRestore(tx, user, body, mode));
  if (mode === 'commit') bustCatalog();
  return Response.json({ stats });
});
