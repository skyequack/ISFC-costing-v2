import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { setIngredientYields } from '@/lib/services/ingredients';
import { codeStr, itemStageIn } from '@/lib/validation/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const yieldsIn = z.object({
  code: codeStr.min(1),
  yThaw: itemStageIn,
  yCut: itemStageIn,
  yCook: itemStageIn,
});

/**
 * D-93: the line editor's "Save to raw material" writes only the three default stages of one ingredient. Needs items.edit like
 * any ingredient edit. No catalog bust: costing never reads the defaults.
 */
export const PUT = withAuth({ perm: 'items.edit' }, async (req, { user }) => {
  const body = await parseJson(req, yieldsIn);
  await inTx(user, (tx, scope) => setIngredientYields(tx, user, scope, body));
  return Response.json({ ok: true });
});
