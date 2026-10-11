import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { clientCreateIn, createClient } from '@/lib/services/clients';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Add a client to a brand. Reads go through the pages (listClients), so there is no GET. */
export const POST = withAuth<{ id: string }>({ perm: 'clients.edit' }, async (req, { user, params }) => {
  const body = await parseJson(req, clientCreateIn);
  const id = await inTx(user, (tx, scope) => createClient(tx, user, scope, params.id, body));
  return Response.json({ id }, { status: 201 });
});
