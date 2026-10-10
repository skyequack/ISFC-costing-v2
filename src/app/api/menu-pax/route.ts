import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { paxIn, setMenuPax } from '@/lib/services/planning';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Headcount for one menu / day / site. Needs recipe.edit (D-32); intentionally unaudited, as in legacy. */
export const PUT = withAuth({ perm: 'recipe.edit' }, async (req, { user }) => {
  const body = await parseJson(req, paxIn);
  await inTx(user, (tx, scope) => setMenuPax(tx, user, scope, body));
  return Response.json({ ok: true });
});
