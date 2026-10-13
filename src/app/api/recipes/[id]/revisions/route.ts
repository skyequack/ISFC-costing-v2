import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { inTx, withScope } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { listRevisions, startRevision } from '@/lib/services/revisions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const body = z.object({ version: z.number().int().min(0) });

/** D-100: revisions of one card, newest first (the first is the one in force now). Same visibility as the card. */
export const GET = withAuth<{ id: string }>({}, async (_req, { user, params }) =>
  Response.json({ revisions: await withScope(user, (q, scope) => listRevisions(q, scope, params.id)) }),
);

/** D-100: "Start new revision" - freeze the card as it is now and start the next revision today. */
export const POST = withAuth<{ id: string }>(
  { perm: 'recipe.edit', limit: 'revision' },
  async (req, { user, params }) => {
    const b = await parseJson(req, body);
    const out = await inTx(user, (tx, scope) => startRevision(tx, user, scope, params.id, b.version));
    return Response.json(out, { status: 201 });
  },
);
