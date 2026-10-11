import { withAuth } from '@/lib/auth/with-auth';
import { inTx } from '@/lib/api';
import { parseJson } from '@/lib/http';
import { saveStock, stockSaveIn } from '@/lib/services/stock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Save the changed cells of one site and day (counts or receipts). Needs stock.edit (D-72); reads go through the Stock page. */
export const PUT = withAuth({ perm: 'stock.edit' }, async (req, { user }) => {
  const body = await parseJson(req, stockSaveIn);
  const out = await inTx(user, (tx, scope) => saveStock(tx, user, scope, body));
  return Response.json(out);
});
