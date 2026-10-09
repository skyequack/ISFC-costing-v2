import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { applyDayIn } from '@/lib/services/planning';
import { applyMenuDay } from '@/lib/services/planning-apply';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuth({ perm: 'recipe.edit' }, async (req, { user }) => {
  const body = await parseJson(req, applyDayIn);
  const out = await inTx(user, (tx, scope) => applyMenuDay(tx, user, scope, body));
  return Response.json(out);
});
