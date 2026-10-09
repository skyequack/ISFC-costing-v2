import { db } from '@/lib/db/client';
import { listIngredients } from '@/lib/db/repo/ingredients';
import { pageCatalog, pageCtx } from '@/lib/page';
import { dashData } from '@/lib/screens/dash';
import { recipeRows } from '@/lib/screens/rows';
import { DashScreen } from '@/components/screens/DashScreen';

export default async function Page() {
  const ctx = await pageCtx();
  const catalog = await pageCatalog();
  const items = await listIngredients(db, ctx.scope);
  const d = dashData(recipeRows(catalog, ctx.scope), items, ctx.brands, catalog, catalog.settings.target);
  return <DashScreen d={d} brandNames={Object.fromEntries(ctx.brands.map((b) => [b.id, b.name]))} />;
}
