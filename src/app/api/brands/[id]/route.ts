import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { brandPatchIn, deleteBrand, updateBrand } from '@/lib/services/brands';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = withAuth<{ id: string }>({ perm: 'brands.edit' }, async (req, { user, params }) => {
  const body = await parseJson(req, brandPatchIn);
  await inTx(user, (tx) => updateBrand(tx, user, params.id, body));
  return Response.json({ ok: true });
});

export const DELETE = withAuth<{ id: string }>({ perm: 'brands.edit' }, async (_req, { user, params }) => {
  await inTx(user, (tx) => deleteBrand(tx, user, params.id));
  return Response.json({ ok: true });
});
