import { db } from '@/lib/db/client';
import { listIngredients } from '@/lib/db/repo/ingredients';
import { listUnits } from '@/lib/services/units';
import { pageCatalog, pageCtx } from '@/lib/page';
import { ItemsScreen } from '@/components/screens/ItemsScreen';

export default async function Page() {
  const ctx = await pageCtx();
  const catalog = await pageCatalog();
  const items = await listIngredients(db, ctx.scope, true);
  const units = await listUnits(db);
  return (
    <ItemsScreen
      items={items}
      brands={ctx.brands.map((b) => ({ id: b.id, name: b.name, code: b.code }))}
      priceDate={catalog.settings.priceDate}
      units={units}
    />
  );
}
