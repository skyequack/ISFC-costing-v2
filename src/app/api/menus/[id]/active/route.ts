import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { setMenuActive } from '@/lib/services/planning';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Menus are deactivated, never deleted (their headcounts would cascade). */
export const POST = withAuth<{ id: string }>({ perm: 'menu.edit' }, async (req, { user, params }) => {
  const b = await parseJson(req, z.object({ active: z.boolean() }));
  await inTx(user, (tx, scope) => setMenuActive(tx, user, scope, params.id, b.active));
  return Response.json({ ok: true });
});
