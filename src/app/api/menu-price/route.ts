import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { bustCatalog, inTx } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { addPriceHistory } from '@/lib/services/ingredients';
import { priceMenuItem } from '@/lib/services/planning';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const body = z.object({ code: z.string().trim().min(1).max(60), price: z.number().finite().min(0).max(1e9) });

/** Price an unpriced menu item straight from the plan (legacy setMenuPrice 1644); writes price history. */
export const POST = withAuth({ perm: 'items.edit' }, async (req, { user }) => {
  const b = await parseJson(req, body);
  const out = await inTx(user, (tx, scope) =>
    priceMenuItem(tx, user, scope, b.code, b.price, (id, was, now) =>
      addPriceHistory(tx, user, id, was, now, 'MENU_PLAN'),
    ),
  );
  bustCatalog();
  return Response.json(out);
});
