import { withAuth } from '@/lib/auth/with-auth';
import { withScope } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { getRevision } from '@/lib/services/revisions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** D-100: one archived revision (read-only). The revision in force now is the card itself. */
export const GET = withAuth<{ id: string; n: string }>({}, async (_req, { user, params }) => {
  const n = Number(params.n);
  if (!Number.isInteger(n) || n < 1) throw new ApiError('not_found', 'Not found');
  return Response.json(await withScope(user, (q, scope) => getRevision(q, scope, params.id, n)));
});
