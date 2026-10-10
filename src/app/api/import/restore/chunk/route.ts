import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { chunkIn, storeChunk } from '@/lib/services/restore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One <= 1.5 MB slice of a backup file (Vercel's request body limit is 4.5 MB). Needs data.admin. */
export const POST = withAuth({ perm: 'data.admin' }, async (req, { user }) => {
  const body = await parseJson(req, chunkIn, 1_700_000);
  await inTx(user, (tx) => storeChunk(tx, user, body));
  return Response.json({ ok: true });
});
