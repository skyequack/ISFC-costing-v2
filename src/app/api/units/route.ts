import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { inTx, withScope } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { addUnit, listUnits } from '@/lib/services/units';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** D-103: the unit list the Items form offers. Every signed-in role may read it. */
export const GET = withAuth({}, async (_req, { user }) =>
  Response.json({ units: await withScope(user, (q) => listUnits(q)) }),
);

const unitIn = z.object({ code: z.string().trim().min(1).max(16) });

export const POST = withAuth({ perm: 'units.edit', limit: 'admin_write' }, async (req, { user }) => {
  const body = await parseJson(req, unitIn);
  await inTx(user, (tx) => addUnit(tx, user, body.code));
  return Response.json({ ok: true }, { status: 201 });
});
