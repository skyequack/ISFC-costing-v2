import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { csvLine } from '@/lib/csv';
import { ApiError } from '@/lib/errors';
import { parseQuery } from '@/lib/http';
import { EXPORT_KINDS, exportAndAudit, exportQuery, type ExportKind } from '@/lib/services/exports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Every export (CSV or the row data an Excel file is built from) is served here so `export` and brand scope are enforced
 * at the data endpoint, written with formula neutralisation (D-36) and audited once with kind + row count (D-44).
 */
export const GET = withAuth<{ kind: string }>({ perm: 'export' }, async (req, { user, params }) => {
  if (!(EXPORT_KINDS as readonly string[]).includes(params.kind)) throw new ApiError('not_found', 'Not found');
  const kind = params.kind as ExportKind;
  const q = parseQuery(req, exportQuery);
  const file = await inTx(user, (tx) => exportAndAudit(tx, user, kind, q));
  if (kind === 'recipes-data') return Response.json(file, { headers: { 'cache-control': 'private, no-store' } });
  return new Response(file.rows.map((r) => csvLine(r)).join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${file.filename.replace(/"/g, '')}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
});
