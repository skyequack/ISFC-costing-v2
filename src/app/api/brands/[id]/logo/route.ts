import { withAuth } from '@/lib/auth/with-auth';
import { inTx, withScope } from '@/lib/api';
import { appendAudit } from '@/lib/db/repo/audit';
import { assertBrandVisible } from '@/lib/db/scope';
import { ApiError } from '@/lib/errors';
import { pgImageStore, validateImage } from '@/lib/images';
import { imageResponse, readImageBody } from '@/lib/images/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuth<{ id: string }>({}, async (req, { user, params }) => {
  const img = await withScope(user, async (q, scope) => {
    assertBrandVisible(scope, params.id);
    return pgImageStore(q, 'logo').get(params.id);
  });
  if (!img) throw new ApiError('not_found', 'Not found');
  return imageResponse(req, img);
});

export const PUT = withAuth<{ id: string }>({ perm: 'brands.edit' }, async (req, { user, params }) => {
  const bytes = await readImageBody(req, 'logo');
  const image = validateImage(bytes, 'logo');
  await inTx(user, async (tx) => {
    const b = await tx.query('SELECT name FROM brand WHERE id = $1', [params.id]);
    if (!b.rows[0]) throw new ApiError('not_found', 'Not found');
    await pgImageStore(tx, 'logo').put(params.id, image, bytes);
    await appendAudit(
      tx,
      user,
      'Brand logo changed',
      `${b.rows[0].name}: set (${image.width}×${image.height}, ${Math.round(image.size / 1024)} KB)`,
    );
  });
  return Response.json({
    url: `/api/brands/${params.id}/logo?v=${image.sha256.slice(0, 8)}`,
    sha256: image.sha256,
    size: image.size,
    width: image.width,
    height: image.height,
  });
});

export const DELETE = withAuth<{ id: string }>({ perm: 'brands.edit' }, async (_req, { user, params }) => {
  await inTx(user, async (tx) => {
    const b = await tx.query('SELECT name FROM brand WHERE id = $1', [params.id]);
    if (!b.rows[0]) throw new ApiError('not_found', 'Not found');
    if (await pgImageStore(tx, 'logo').delete(params.id))
      await appendAudit(tx, user, 'Brand logo changed', `${b.rows[0].name}: removed`);
  });
  return Response.json({ ok: true });
});
