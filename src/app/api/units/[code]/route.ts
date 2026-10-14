import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { deleteUnit } from '@/lib/services/units';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = withAuth<{ code: string }>(
  { perm: 'units.edit', limit: 'admin_write' },
  async (_req, { user, params }) => {
    let code = params.code;
    try {
      code = decodeURIComponent(code);
    } catch {
      /* keep the raw segment: it will simply not be found */
    }
    await inTx(user, (tx) => deleteUnit(tx, user, code));
    return Response.json({ ok: true });
  },
);
