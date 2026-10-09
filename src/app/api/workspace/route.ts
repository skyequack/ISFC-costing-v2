import { z } from 'zod';
import { cookies } from 'next/headers';
import { withAuth } from '@/lib/auth/with-auth';
import { withScope } from '@/lib/api';
import { assertBrandVisible } from '@/lib/db/scope';
import { parseJson } from '@/lib/http';
import { WORKSPACE_COOKIE } from '@/lib/page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const body = z.object({ brandId: z.string().max(64) });

/**
 * Switch the active brand workspace (legacy pickBrand). It is a UI filter, never access control: the id is checked
 * against the caller's scope and kept in a cookie; '' clears it. No localStorage (CLAUDE.md).
 */
export const POST = withAuth({}, async (req, { user }) => {
  const b = await parseJson(req, body);
  if (b.brandId) await withScope(user, async (_q, scope) => assertBrandVisible(scope, b.brandId));
  const jar = await cookies();
  if (b.brandId) jar.set(WORKSPACE_COOKIE, b.brandId, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 180 });
  else jar.delete(WORKSPACE_COOKIE);
  return Response.json({ ok: true });
});
