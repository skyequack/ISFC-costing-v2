import { withAuth } from '@/lib/auth/with-auth';
import { inTx, withScope } from '@/lib/api';
import { listClients } from '@/lib/db/repo/clients';
import { assertBrandVisible } from '@/lib/db/scope';
import { parseJson } from '@/lib/http';
import { clientCreateIn, createClient } from '@/lib/services/clients';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Clients of one brand (any signed-in role; the brand must be in the caller's scope). */
export const GET = withAuth<{ id: string }>({}, async (_req, { user, params }) => {
  const clients = await withScope(user, async (q, scope) => {
    assertBrandVisible(scope, params.id);
    return (await listClients(q, scope)).filter((c) => c.brandId === params.id);
  });
  return Response.json({ clients });
});

export const POST = withAuth<{ id: string }>({ perm: 'clients.edit' }, async (req, { user, params }) => {
  const body = await parseJson(req, clientCreateIn);
  const id = await inTx(user, (tx, scope) => createClient(tx, user, scope, params.id, body));
  return Response.json({ id }, { status: 201 });
});
