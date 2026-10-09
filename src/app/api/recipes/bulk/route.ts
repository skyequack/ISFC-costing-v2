import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { bustCatalog, inTx } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { deleteRecipes, lockRecipes, unlockRecipes } from '@/lib/services/recipes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('lock'),
    ids: z.array(z.string().min(1)).min(1).max(500),
    approvedBy: z.string().trim().min(1).max(120),
  }),
  z.object({ action: z.literal('unlock'), ids: z.array(z.string().min(1)).min(1).max(500) }),
  z.object({ action: z.literal('delete'), ids: z.array(z.string().min(1)).min(1).max(500) }),
]);

/** All-or-nothing: one transaction, every id must be in the caller's scope (a single miss rolls everything back). */
export const POST = withAuth({}, async (req, { user }) => {
  const b = await parseJson(req, body);
  const out = await inTx(user, async (tx, scope) => {
    if (b.action === 'lock') {
      await lockRecipes(tx, user, scope, b.ids, b.approvedBy);
      return { ids: b.ids };
    }
    if (b.action === 'unlock') {
      await unlockRecipes(tx, user, scope, b.ids);
      return { ids: b.ids };
    }
    return { ids: await deleteRecipes(tx, user, scope, b.ids) };
  });
  bustCatalog();
  return Response.json(out);
});
