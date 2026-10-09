import { db } from '@/lib/db/client';
import { listIngredients } from '@/lib/db/repo/ingredients';
import { pageCatalog, pageCtx } from '@/lib/page';
import { healthRows } from '@/lib/screens/health';
import { HealthScreen } from '@/components/screens/SimpleScreens';

export default async function Page() {
  const ctx = await pageCtx();
  const catalog = await pageCatalog();
  const items = await listIngredients(db, ctx.scope);
  return <HealthScreen live={healthRows(catalog, ctx.scope, items)} flagged={items.filter((i) => i.flag).length} />;
}
