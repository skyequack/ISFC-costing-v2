import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { clerkPort } from '@/lib/auth/clerk-port';
import { parseJson } from '@/lib/http';
import { invitePatchIn, revokeInvite, updateInvite } from '@/lib/services/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `id` is the Clerk invitation id (D-78). A role change creates a new invitation, so the new id is returned (D-80). */
export const PATCH = withAuth<{ id: string }>(
  { perm: 'users.manage', limit: 'user_admin' },
  async (req, { user, params }) => {
    const body = await parseJson(req, invitePatchIn);
    const out = await inTx(user, (tx) => updateInvite(tx, clerkPort(), user, params.id, body));
    return Response.json({ ok: true, id: out.id });
  },
);

export const DELETE = withAuth<{ id: string }>(
  { perm: 'users.manage', limit: 'user_admin' },
  async (_req, { user, params }) => {
    await inTx(user, (tx) => revokeInvite(tx, clerkPort(), user, params.id));
    return Response.json({ ok: true });
  },
);
