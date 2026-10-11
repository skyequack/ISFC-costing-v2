import { db } from '@/lib/db/client';
import { listIngredients } from '@/lib/db/repo/ingredients';
import { pageCatalog, pageCtx } from '@/lib/page';
import { can } from '@/lib/permissions';
import { dbHealthRows, healthRows } from '@/lib/screens/health';
import { HealthScreen } from '@/components/screens/SimpleScreens';

export default async function Page() {
  const ctx = await pageCtx();
  const catalog = await pageCatalog();
  const items = await listIngredients(db, ctx.scope);
  const live = [
    ...healthRows(catalog, ctx.scope, items),
    ...(await dbHealthRows(db, ctx.scope, can(ctx.user.role, 'data.admin'))),
  ];
  return <HealthScreen live={live} flagged={items.filter((i) => i.flag).length} />;
}
