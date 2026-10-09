import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { withScope } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { recipeReferences } from '@/lib/services/recipes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Which surviving cards still use the codes of the cards about to be deleted (legacy confirmDelete 2922 warning). */
export const POST = withAuth({}, async (req, { user }) => {
  const b = await parseJson(req, z.object({ ids: z.array(z.string().min(1)).min(1).max(500) }));
  return Response.json(await withScope(user, (q, scope) => recipeReferences(q, scope, b.ids)));
});
