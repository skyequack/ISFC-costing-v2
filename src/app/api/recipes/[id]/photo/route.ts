import { withAuth } from '@/lib/auth/with-auth';
import { inTx, withScope } from '@/lib/api';
import { appendAudit } from '@/lib/db/repo/audit';
import { getRecipe } from '@/lib/db/repo/recipes';
import { ApiError } from '@/lib/errors';
import { pgImageStore, validateImage } from '@/lib/images';
import { imageResponse, readImageBody } from '@/lib/images/http';
import { assertEditableCard } from '@/lib/services/recipes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuth<{ id: string }>({}, async (req, { user, params }) => {
  const img = await withScope(user, async (q, scope) => {
    await getRecipe(q, scope, params.id); // 404 when out of scope
    return pgImageStore(q, 'photo').get(params.id);
  });
  if (!img) throw new ApiError('not_found', 'Not found');
  return imageResponse(req, img);
});

export const PUT = withAuth<{ id: string }>({ perm: 'recipe.edit', limit: 'upload' }, async (req, { user, params }) => {
  const bytes = await readImageBody(req, 'photo');
  const image = validateImage(bytes, 'photo'); // the declared content-type is ignored
  await inTx(user, async (tx, scope) => {
    const card = await assertEditableCard(tx, user, scope, params.id);
    await pgImageStore(tx, 'photo').put(params.id, image, bytes);
    await appendAudit(
      tx,
      user,
      'Added a dish photo',
      `${card.code || card.name} · ${image.width}×${image.height} · ${Math.round(image.size / 1024)} KB`,
    );
  });
  return Response.json({
    url: `/api/recipes/${params.id}/photo?v=${image.sha256.slice(0, 8)}`,
    sha256: image.sha256,
    size: image.size,
    width: image.width,
    height: image.height,
  });
});

export const DELETE = withAuth<{ id: string }>(
  { perm: 'recipe.edit', limit: 'upload' },
  async (_req, { user, params }) => {
    await inTx(user, async (tx, scope) => {
      const card = await assertEditableCard(tx, user, scope, params.id);
      if (await pgImageStore(tx, 'photo').delete(params.id))
        await appendAudit(tx, user, 'Removed the dish photo', card.code || card.name);
    });
    return Response.json({ ok: true });
  },
);
