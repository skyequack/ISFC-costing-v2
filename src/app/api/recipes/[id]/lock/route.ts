import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { bustCatalog, inTx } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { lockRecipes } from '@/lib/services/recipes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const body = z.object({ approvedBy: z.string().trim().min(1).max(120), overrideReason: z.string().trim().min(1).max(500).optional() });

export const POST = withAuth<{ id: string }>({ perm: 'recipe.lock' }, async (req, { user, params }) => {
  const b = await parseJson(req, body);
  await inTx(user, (tx, scope) => lockRecipes(tx, user, scope, [params.id], b.approvedBy, b.overrideReason));
  bustCatalog();
  return Response.json({ ok: true });
});
