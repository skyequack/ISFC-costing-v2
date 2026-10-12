import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { clerkPort } from '@/lib/auth/clerk-port';
import { parseJson } from '@/lib/http';
import { inviteIn, inviteUser } from '@/lib/services/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuth({ perm: 'users.manage', limit: 'user_admin' }, async (req, { user }) => {
  const body = await parseJson(req, inviteIn);
  await inTx(user, (tx) => inviteUser(tx, clerkPort(), user, body));
  return Response.json({ ok: true }, { status: 201 });
});
