import { withAuth } from '@/lib/auth/with-auth';
import { bustCatalog, inTx, withScope } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { recipeDetail } from '@/lib/services/recipe-detail';
import { deleteRecipes, saveRecipe } from '@/lib/services/recipes';
import { recipeSaveIn } from '@/lib/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuth<{ id: string }>({}, async (_req, { user, params }) =>
  Response.json(await withScope(user, (q, scope) => recipeDetail(q, scope, params.id))),
);

export const PATCH = withAuth<{ id: string }>({}, async (req, { user, params }) => {
  const body = await parseJson(req, recipeSaveIn);
  const detail = await inTx(user, async (tx, scope) => {
    await saveRecipe(tx, user, scope, params.id, body);
    return recipeDetail(tx, scope, params.id);
  });
  bustCatalog();
  return Response.json(detail);
});

export const DELETE = withAuth<{ id: string }>({}, async (_req, { user, params }) => {
  const ids = await inTx(user, (tx, scope) => deleteRecipes(tx, user, scope, [params.id]));
  bustCatalog();
  return Response.json({ deleted: ids });
});
