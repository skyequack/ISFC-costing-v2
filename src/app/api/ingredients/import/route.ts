import { withAuth } from '@/lib/auth/with-auth';
import { bustCatalog, inTx } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { parseJson } from '@/lib/http';
import { commitItemImport, itemImportIn, previewItemImport } from '@/lib/services/import-items';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Price-list import, one part (<= 500 rows) per call. `?mode=dry-run` returns the per-item plan with variance and a hash;
 * `?mode=commit` must carry that hash and writes the part in one transaction (D-37, D-43). Needs items.edit.
 */
export const POST = withAuth({ perm: 'items.edit' }, async (req, { user }) => {
  const mode = new URL(req.url).searchParams.get('mode');
  if (mode !== 'dry-run' && mode !== 'commit') throw new ApiError('bad_request', 'mode must be dry-run or commit');
  const body = await parseJson(req, itemImportIn, 1_500_000);
  if (mode === 'dry-run') return Response.json(await inTx(user, (tx, scope) => previewItemImport(tx, user, scope, body)));
  const out = await inTx(user, (tx, scope) => commitItemImport(tx, user, scope, body));
  bustCatalog();
  return Response.json(out);
});
