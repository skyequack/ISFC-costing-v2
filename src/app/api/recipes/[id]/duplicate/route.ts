import { withAuth } from '@/lib/auth/with-auth';
import { bustCatalog, inTx } from '@/lib/api';
import { duplicateRecipe } from '@/lib/services/recipes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuth<{ id: string }>({ perm: 'recipe.create' }, async (_req, { user, params }) => {
  const id = await inTx(user, (tx, scope) => duplicateRecipe(tx, user, scope, params.id));
  bustCatalog();
  return Response.json({ id }, { status: 201 });
});
