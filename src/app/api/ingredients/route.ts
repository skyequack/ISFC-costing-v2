import { withAuth } from '@/lib/auth/with-auth';
import { bustCatalog, inTx, withScope } from '@/lib/api';
import { listIngredients } from '@/lib/db/repo/ingredients';
import { parseJson } from '@/lib/http';
import { createIngredient } from '@/lib/services/ingredients';
import { ingredientIn } from '@/lib/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuth({}, async (_req, { user }) =>
  Response.json({ ingredients: await withScope(user, (q, scope) => listIngredients(q, scope)) }),
);

export const POST = withAuth({ perm: 'items.edit' }, async (req, { user }) => {
  const body = await parseJson(req, ingredientIn);
  const id = await inTx(user, (tx, scope) => createIngredient(tx, user, scope, body));
  bustCatalog();
  return Response.json({ id }, { status: 201 });
});
