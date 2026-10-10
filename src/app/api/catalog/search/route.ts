import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { withScope } from '@/lib/api';
import { parseQuery } from '@/lib/http';
import { searchPicker } from '@/lib/services/catalog-search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const query = z.object({
  brandId: z.string().min(1).max(64),
  q: z.string().max(100).default(''),
  limit: z.coerce.number().int().min(0).max(200).default(30),
});

/** Ingredient picker data for the recipe editor (autocomplete 30, "Search raw materials" 60). */
export const GET = withAuth({}, async (req, { user }) => {
  const p = parseQuery(req, query);
  return Response.json(await withScope(user, (db, scope) => searchPicker(db, scope, p.brandId, p.q, p.limit)));
});
