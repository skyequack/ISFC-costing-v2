import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { parseJson } from '@/lib/http';
import {
  commitStockImport,
  previewStockImport,
  stockImportIn,
  stockUndoIn,
  undoReceiptUpload,
} from '@/lib/services/import-stock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Stock count or receipt upload (D-73), the whole file in one call (<= 5000 rows, 2 MB). `?mode=dry-run` returns the plan and a
 * hash and writes nothing; `?mode=commit` must carry that hash and loads the file in one transaction; `?mode=undo` `{hash}` takes back a receipts upload. Needs stock.edit.
 */
export const POST = withAuth({ perm: 'stock.edit', limit: 'import' }, async (req, { user }) => {
  const mode = new URL(req.url).searchParams.get('mode');
  if (mode !== 'dry-run' && mode !== 'commit' && mode !== 'undo')
    throw new ApiError('bad_request', 'mode must be dry-run, commit or undo');
  if (mode === 'undo') {
    const undo = await parseJson(req, stockUndoIn);
    return Response.json(await inTx(user, (tx, scope) => undoReceiptUpload(tx, user, scope, undo)));
  }
  const body = await parseJson(req, stockImportIn, 2_000_000);
  if (mode === 'dry-run')
    return Response.json(await inTx(user, (tx, scope) => previewStockImport(tx, user, scope, body)));
  return Response.json(await inTx(user, (tx, scope) => commitStockImport(tx, user, scope, body)));
});
