import { db } from '@/lib/db/client';
import { listIngredients } from '@/lib/db/repo/ingredients';
import { pageCatalog, pageCtx } from '@/lib/page';
import { ConvScreen } from '@/components/screens/ConvScreen';

export default async function Page() {
  const ctx = await pageCtx();
  const catalog = await pageCatalog();
  const items = await listIngredients(db, ctx.scope);
  // how many visible cards use each converted item (legacy delConv warning)
  const used: Record<string, number> = {};
  const convCodes = new Set(items.filter((i) => i.conv).map((i) => i.code));
  const visible = new Set(
    Object.entries(catalog.cards)
      .filter(([, c]) => ctx.scope.brandIds.includes(c.brandId))
      .map(([code]) => code),
  );
  for (const r of catalog.context.recipes.values()) {
    if (!visible.has(r.code)) continue;
    for (const code of new Set(r.lines.map((l) => l.code))) if (convCodes.has(code)) used[code] = (used[code] ?? 0) + 1;
  }
  return (
    <ConvScreen
      items={items.map((i) => ({ id: i.id, code: i.code, name: i.name, uom: i.uom, price: i.price, conv: i.conv }))}
      used={used}
    />
  );
}
