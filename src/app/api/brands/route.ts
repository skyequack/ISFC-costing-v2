import { withAuth } from '@/lib/auth/with-auth';
import { inTx, withScope } from '@/lib/api';
import { listBrands } from '@/lib/db/repo/brands';
import { parseJson } from '@/lib/http';
import { brandCreateIn, createBrand } from '@/lib/services/brands';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuth({}, async (_req, { user }) => {
  const brands = await withScope(user, (q, scope) => listBrands(q, scope));
  return Response.json({
    brands: brands.map((b) => ({
      ...b,
      logoUrl: b.logoSha ? `/api/brands/${b.id}/logo?v=${b.logoSha.slice(0, 8)}` : null,
    })),
  });
});

export const POST = withAuth({ perm: 'brands.edit', limit: 'admin_write' }, async (req, { user }) => {
  const body = await parseJson(req, brandCreateIn);
  const id = await inTx(user, (tx) => createBrand(tx, user, body));
  return Response.json({ id }, { status: 201 });
});
