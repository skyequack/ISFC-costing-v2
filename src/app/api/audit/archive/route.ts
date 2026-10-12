import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { archiveAudit } from '@/lib/services/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuth({ perm: 'data.admin', limit: 'admin_write' }, async (_req, { user }) => {
  await inTx(user, (tx) => archiveAudit(tx, user));
  return Response.json({ ok: true });
});
