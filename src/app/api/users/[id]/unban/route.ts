import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { clerkPort } from '@/lib/auth/clerk-port';
import { setUserBanned } from '@/lib/services/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withAuth<{ id: string }>(
  { perm: 'users.manage', limit: 'user_admin' },
  async (_req, { user, params }) => {
    await inTx(user, (tx) => setUserBanned(tx, clerkPort(), user, params.id, false));
    return Response.json({ ok: true });
  },
);
