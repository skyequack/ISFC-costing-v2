import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { bustCatalog, inTx } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { removeConversion, setConversion } from '@/lib/services/ingredients';
import { UNITS } from '@/lib/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const body = z.object({ recipeUnit: z.enum(UNITS), factor: z.number().finite().gt(0).max(1e9) });

/** `id` is the ingredient id: one conversion per ingredient (legacy S.conv[code]). */
export const PUT = withAuth<{ id: string }>({ perm: 'conv.edit' }, async (req, { user, params }) => {
  const b = await parseJson(req, body);
  await inTx(user, (tx, scope) => setConversion(tx, user, scope, params.id, b.recipeUnit, b.factor));
  bustCatalog();
  return Response.json({ ok: true });
});

export const DELETE = withAuth<{ id: string }>({ perm: 'conv.edit' }, async (_req, { user, params }) => {
  await inTx(user, (tx, scope) => removeConversion(tx, user, scope, params.id));
  bustCatalog();
  return Response.json({ ok: true });
});
