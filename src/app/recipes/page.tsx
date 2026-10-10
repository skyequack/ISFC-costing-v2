import { pageCatalog, pageCtx } from '@/lib/page';
import { recipeRows } from '@/lib/screens/rows';
import { RecipesScreen } from '@/components/screens/RecipesScreen';

export default async function Page() {
  const ctx = await pageCtx();
  const catalog = await pageCatalog();
  return (
    <RecipesScreen
      rows={recipeRows(catalog, ctx.scope)}
      brands={ctx.brands.map((b) => ({ id: b.id, name: b.name }))}
      workspaceId={ctx.workspaceId}
      target={catalog.settings.target}
    />
  );
}
