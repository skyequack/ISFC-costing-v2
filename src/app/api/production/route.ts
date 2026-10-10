import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { productionIn, setProduction } from '@/lib/services/planning';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Portions for one dish / day / site. Needs recipe.edit (D-32); unaudited, as in legacy. */
export const PUT = withAuth({ perm: 'recipe.edit' }, async (req, { user }) => {
  const body = await parseJson(req, productionIn);
  await inTx(user, (tx, scope) => setProduction(tx, user, scope, body));
  return Response.json({ ok: true });
});
