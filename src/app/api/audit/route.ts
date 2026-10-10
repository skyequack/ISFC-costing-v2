import { withAuth } from '@/lib/auth/with-auth';
import { inTx, withScope } from '@/lib/api';
import { parseQuery } from '@/lib/http';
import { auditExport, auditQuery, listAudit } from '@/lib/services/audit';
import { can } from '@/lib/permissions';
import { ApiError } from '@/lib/errors';
import { csvLine } from '@/lib/csv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuth({ perm: 'audit.view' }, async (req, { user }) => {
  const p = parseQuery(req, auditQuery);
  if (new URL(req.url).searchParams.get('format') === 'csv') {
    if (!can(user.role, 'export')) throw new ApiError('forbidden', 'Your role cannot do that');
    const r = await withScope(user, (q) => listAudit(q, user, { ...p, limit: 1000, offset: 0 }));
    await inTx(user, (tx) => auditExport(tx, user, 'audit log', r.rows.length));
    const lines = [csvLine(['When', 'User', 'Role', 'Action', 'Detail'])].concat(
      r.rows.map((x) => csvLine([x.at, x.user, x.role, x.action, x.detail])),
    );
    return new Response(lines.join('\n'), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="ISFC-audit-log.csv"',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  return Response.json(await withScope(user, (q) => listAudit(q, user, p)));
});
