import { palette } from '@/lib/brand/palette';
import { pageCatalog, pageCtx } from '@/lib/page';
import { brandTiles } from '@/lib/screens/brands';
import { recipeRows } from '@/lib/screens/rows';
import { BrandsScreen } from '@/components/screens/BrandsScreen';

export default async function Page() {
  const ctx = await pageCtx();
  const catalog = await pageCatalog();
  const tiles = brandTiles(ctx.brands, recipeRows(catalog, ctx.scope), catalog.settings.target, (b) => {
    const p = palette(b.color || '#BB5E1E', b.inkColor);
    return { onSolid: p.onSolid, text: p.text };
  });
  return <BrandsScreen tiles={tiles} workspaceId={ctx.workspaceId} target={catalog.settings.target} />;
}
