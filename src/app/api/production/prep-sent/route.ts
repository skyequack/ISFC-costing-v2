import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { appendAudit } from '@/lib/db/repo/audit';
import { parseJson } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const body = z.object({ site: z.string().trim().min(1).max(60), materials: z.number().int().min(0).max(100000) });

/** Legacy prepPrint logged `Sent a requisition to the store` even when the print was cancelled (known bug 23: kept). Needs export. */
export const POST = withAuth({ perm: 'export' }, async (req, { user }) => {
  const b = await parseJson(req, body);
  await inTx(user, (tx) =>
    appendAudit(
      tx,
      user,
      'Sent a requisition to the store',
      `${b.site === 'All sites' ? 'all sites' : b.site} · ${b.materials} materials`,
    ),
  );
  return Response.json({ ok: true });
});
