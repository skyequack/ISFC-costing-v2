import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { clientPatchIn, deleteClient, updateClient } from '@/lib/services/clients';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = withAuth<{ id: string }>({ perm: 'clients.edit' }, async (req, { user, params }) => {
  const body = await parseJson(req, clientPatchIn);
  await inTx(user, (tx, scope) => updateClient(tx, user, scope, params.id, body));
  return Response.json({ ok: true });
});

export const DELETE = withAuth<{ id: string }>({ perm: 'clients.edit' }, async (_req, { user, params }) => {
  await inTx(user, (tx, scope) => deleteClient(tx, user, scope, params.id));
  return Response.json({ ok: true });
});
