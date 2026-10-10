import { withAuth } from '@/lib/auth/with-auth';
import { bustCatalog, inTx } from '@/lib/api';
import { restoreRecipes } from '@/lib/services/recipes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuth<{ id: string }>({ perm: 'recipe.delete' }, async (_req, { user, params }) => {
  const ids = await inTx(user, (tx, scope) => restoreRecipes(tx, user, scope, [params.id]));
  bustCatalog();
  return Response.json({ restored: ids });
});
