import { db } from '@/lib/db/client';
import { listIngredients } from '@/lib/db/repo/ingredients';
import { visibleSites } from '@/lib/db/repo/stock';
import { pageCatalog, pageCtx } from '@/lib/page';
import { recipeRows } from '@/lib/screens/rows';
import { BackupScreen } from '@/components/screens/BackupScreen';

export default async function Page() {
  const ctx = await pageCtx();
  const catalog = await pageCatalog();
  const items = await listIngredients(db, ctx.scope);
  const ph = await db.query(
    `SELECT count(*)::int AS n, coalesce(sum(p.size), 0)::bigint AS bytes FROM recipe_photo p JOIN recipe r ON r.id = p.recipe_id
      WHERE r.deleted_at IS NULL AND r.brand_id = ANY($1::text[])`,
    [[...ctx.scope.brandIds]],
  );
  return (
    <BackupScreen
      sites={await visibleSites(db, ctx.scope)}
      counts={{
        items: items.length,
        recipes: recipeRows(catalog, ctx.scope).length,
        conv: items.filter((i) => i.conv).length,
        photos: Number(ph.rows[0]?.n ?? 0),
        photoKb: Math.round(Number(ph.rows[0]?.bytes ?? 0) / 1024),
      }}
    />
  );
}
