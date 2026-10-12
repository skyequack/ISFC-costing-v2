import { withAuth } from '@/lib/auth/with-auth';
import { bustCatalog, inTx } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { parseJson } from '@/lib/http';
import { commitRecipeImport, previewRecipeImport, recipeImportIn } from '@/lib/services/import-recipes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Recipe-card upload, one part (<= 100 cards) per call; dry-run then commit with the dry-run hash (D-37). Needs recipe.create. */
export const POST = withAuth({ perm: 'recipe.create', limit: 'import' }, async (req, { user }) => {
  const mode = new URL(req.url).searchParams.get('mode');
  if (mode !== 'dry-run' && mode !== 'commit') throw new ApiError('bad_request', 'mode must be dry-run or commit');
  const body = await parseJson(req, recipeImportIn, 3_000_000);
  if (mode === 'dry-run')
    return Response.json(await inTx(user, (tx, scope) => previewRecipeImport(tx, user, scope, body)));
  const out = await inTx(user, (tx, scope) => commitRecipeImport(tx, user, scope, body));
  bustCatalog();
  return Response.json(out);
});
