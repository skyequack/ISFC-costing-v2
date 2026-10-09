import { db } from '@/lib/db/client';
import { visibleBrandIds } from '@/lib/db/scope';
import { withAuth } from '@/lib/auth/with-auth';
import { permissionsFor, ROLES } from '@/lib/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuth({}, async (_req, { user }) => {
  const scope = await visibleBrandIds(user, db);
  return Response.json({
    user: { id: user.id, name: user.name, email: user.email },
    role: user.role,
    roleLabel: ROLES[user.role].label,
    permissions: permissionsFor(user.role),
    brandIds: scope.brandIds,
    active: true,
  });
});
