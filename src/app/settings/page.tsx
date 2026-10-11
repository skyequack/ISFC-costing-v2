import { db } from '@/lib/db/client';
import { listClients } from '@/lib/db/repo/clients';
import { getSettings } from '@/lib/db/repo/settings';
import { pageCatalog, pageCtx } from '@/lib/page';
import { recipeRows } from '@/lib/screens/rows';
import { SettingsScreen } from '@/components/screens/SettingsScreen';

export default async function Page() {
  const ctx = await pageCtx();
  const catalog = await pageCatalog();
  const settings = await getSettings(db);
  const rows = recipeRows(catalog, ctx.scope);
  const clientRows = await listClients(db, ctx.scope);
  const brands = ctx.brands.map((b) => {
    const rs = rows.filter((r) => r.brandId === b.id);
    return {
      id: b.id,
      code: b.code,
      name: b.name,
      color: b.color,
      logoUrl: b.logoUrl,
      locations: b.locations,
      cards: rs.length,
      locked: rs.filter((r) => r.status === 'LOCKED').length,
    };
  });
  const names = new Map(ctx.brands.map((b) => [b.id, b.name]));
  const impact = rows.filter((r) => r.type === 'menu').map((r) => ({ ...r, brandName: names.get(r.brandId) ?? '' }));
  const clients = clientRows.map((c) => ({ ...c, brandName: names.get(c.brandId) ?? '' }));
  return <SettingsScreen settings={settings} brands={brands} clients={clients} impact={impact} />;
}
