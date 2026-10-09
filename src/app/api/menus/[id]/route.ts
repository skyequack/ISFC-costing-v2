import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { menuSaveIn, saveMenu } from '@/lib/services/planning';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = withAuth<{ id: string }>({ perm: 'menu.edit' }, async (req, { user, params }) => {
  const body = await parseJson(req, menuSaveIn);
  await inTx(user, (tx, scope) => saveMenu(tx, user, scope, params.id, body));
  return Response.json({ ok: true });
});
