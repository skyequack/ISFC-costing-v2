import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { inTx, withScope } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { createMenu, listMenusFor } from '@/lib/services/planning';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createIn = z.object({
  name: z.string().trim().min(1).max(120),
  days: z.array(z.string().trim().min(1).max(20)).min(1).max(7),
});

/** Menu plans belong to the SSEM project: a caller without SSEM in scope gets 404 (D-06). */
export const GET = withAuth({}, async (_req, { user }) =>
  Response.json({ menus: await withScope(user, (q, scope) => listMenusFor(q, scope, true)) }),
);

export const POST = withAuth({ perm: 'menu.edit' }, async (req, { user }) => {
  const b = await parseJson(req, createIn);
  const id = await inTx(user, (tx, scope) => createMenu(tx, user, scope, b.name, b.days));
  return Response.json({ id }, { status: 201 });
});
