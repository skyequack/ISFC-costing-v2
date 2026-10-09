import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { bustCatalog, inTx } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { deleteIngredient, updateIngredient } from '@/lib/services/ingredients';
import { ingredientIn } from '@/lib/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchIn = ingredientIn.extend({ version: z.number().int().min(0) });

export const PATCH = withAuth<{ id: string }>({ perm: 'items.edit' }, async (req, { user, params }) => {
  const body = await parseJson(req, patchIn);
  await inTx(user, (tx, scope) => updateIngredient(tx, user, scope, params.id, body));
  bustCatalog();
  return Response.json({ ok: true });
});

export const DELETE = withAuth<{ id: string }>({ perm: 'items.edit' }, async (_req, { user, params }) => {
  await inTx(user, (tx, scope) => deleteIngredient(tx, user, scope, params.id));
  bustCatalog();
  return Response.json({ ok: true });
});
