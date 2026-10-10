import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { clerkPort } from '@/lib/auth/clerk-port';
import { parseJson } from '@/lib/http';
import { deleteUser, updateUser, userPatchIn } from '@/lib/services/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `id` is the Clerk user id. */
export const PATCH = withAuth<{ id: string }>({ perm: 'users.manage' }, async (req, { user, params }) => {
  const body = await parseJson(req, userPatchIn);
  await inTx(user, (tx) => updateUser(tx, clerkPort(), user, params.id, body));
  return Response.json({ ok: true });
});

export const DELETE = withAuth<{ id: string }>({ perm: 'users.manage' }, async (_req, { user, params }) => {
  await inTx(user, (tx) => deleteUser(tx, clerkPort(), user, params.id));
  return Response.json({ ok: true });
});
