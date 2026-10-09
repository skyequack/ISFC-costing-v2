import { withAuth } from '@/lib/auth/with-auth';
import { bustCatalog, inTx, withScope } from '@/lib/api';
import { listRecipes } from '@/lib/db/repo/recipes';
import { parseJson } from '@/lib/http';
import { createRecipe } from '@/lib/services/recipes';
import { recipeCreateIn } from '@/lib/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuth({}, async (_req, { user }) => {
  const rows = await withScope(user, (q, scope) => listRecipes(q, scope));
  return Response.json({
    recipes: rows.map((r) => ({
      ...r,
      photoUrl: r.photoSha ? `/api/recipes/${r.id}/photo?v=${r.photoSha.slice(0, 8)}` : null,
    })),
  });
});

export const POST = withAuth({ perm: 'recipe.create' }, async (req, { user }) => {
  const body = await parseJson(req, recipeCreateIn);
  const id = await inTx(user, (tx, scope) => createRecipe(tx, user, scope, body));
  bustCatalog();
  return Response.json({ id }, { status: 201 });
});
