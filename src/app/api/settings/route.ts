import { withAuth } from '@/lib/auth/with-auth';
import { bustCatalog, inTx, withScope } from '@/lib/api';
import { getSettings } from '@/lib/db/repo/settings';
import { parseJson } from '@/lib/http';
import { settingsIn, updateSettings } from '@/lib/services/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuth({}, async (_req, { user }) => Response.json(await withScope(user, (q) => getSettings(q))));

export const PATCH = withAuth({ perm: 'settings.edit' }, async (req, { user }) => {
  const body = await parseJson(req, settingsIn);
  const out = await inTx(user, async (tx) => {
    const r = await updateSettings(tx, user, body);
    return { ...r, settings: await getSettings(tx) };
  });
  bustCatalog();
  return Response.json(out);
});
