import { db } from '@/lib/db/client';
import { withPublic } from '@/lib/auth/with-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withPublic(async () => {
  try {
    await db.query('SELECT 1');
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 503 }); // no internals
  }
});
