import { withAuth } from '@/lib/auth/with-auth';
import { withScope } from '@/lib/api';
import { clerkPort } from '@/lib/auth/clerk-port';
import { listUsers } from '@/lib/services/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuth({ perm: 'users.manage' }, async (_req, { user }) =>
  Response.json({ users: await withScope(user, (q) => listUsers(q, clerkPort(), user)) }),
);
