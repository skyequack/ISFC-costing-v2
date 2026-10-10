import { withAuth } from '@/lib/auth/with-auth';
import { bustCatalog, inTx } from '@/lib/api';
import { unlockRecipes } from '@/lib/services/recipes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuth<{ id: string }>({ perm: 'recipe.unlock' }, async (_req, { user, params }) => {
  await inTx(user, (tx, scope) => unlockRecipes(tx, user, scope, [params.id]));
  bustCatalog();
  return Response.json({ ok: true });
});
