import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import type pg from 'pg';

/**
 * Visual smoke harness (npm run preview:screens): renders every screen inside the real Shell, with the real legacy.css, from
 * the Neon dev data, into public/_preview/*.html so they can be looked at in a browser without signing in. Not a gate.
 */
const h = vi.hoisted(() => ({ path: '/dash' }));
vi.mock('next/navigation', () => ({
  usePathname: () => h.path,
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('@clerk/nextjs', () => ({ useClerk: () => ({ signOut: () => undefined }) }));
vi.mock('next/cache', () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

import { Shell } from '@/components/shell/Shell';
import { palette } from '@/lib/brand/palette';
import { loadCatalog } from '@/lib/db/catalog';
import { listBrands } from '@/lib/db/repo/brands';
import { listIngredients } from '@/lib/db/repo/ingredients';
import { getSettings } from '@/lib/db/repo/settings';
import { makeScope } from '@/lib/db/scope';
import { permissionsFor, type Role } from '@/lib/permissions';
import { brandTiles } from '@/lib/screens/brands';
import { dashData } from '@/lib/screens/dash';
import { healthRows } from '@/lib/screens/health';
import { loadPlan, loadPrep } from '@/lib/screens/plan';
import { loadProd } from '@/lib/screens/prod';
import { recipeRows } from '@/lib/screens/rows';
import { listAudit, auditQuery } from '@/lib/services/audit';
import { recipeDetail } from '@/lib/services/recipe-detail';
import { menusVisible } from '@/lib/services/planning';
import { connect } from '../db/helpers';
import { BrandsScreen } from '@/components/screens/BrandsScreen';
import { DashScreen } from '@/components/screens/DashScreen';
import { RecipesScreen } from '@/components/screens/RecipesScreen';
import { EditScreen } from '@/components/recipes/EditScreen';
import { ItemsScreen } from '@/components/screens/ItemsScreen';
import { ConvScreen } from '@/components/screens/ConvScreen';
import { SettingsScreen } from '@/components/screens/SettingsScreen';
import { AuditScreen, HealthScreen, YieldsScreen } from '@/components/screens/SimpleScreens';
import { UsersScreen } from '@/components/screens/UsersScreen';
import { ProdScreen } from '@/components/screens/ProdScreen';
import { PrepScreen } from '@/components/screens/PrepScreen';
import { PlanScreen } from '@/components/screens/PlanScreen';
import { BackupScreen } from '@/components/screens/BackupScreen';

const out = path.resolve(__dirname, '../../public/_preview');

describe.skipIf(!process.env.TEST_DATABASE_URL)('render every screen to public/_preview', () => {
  let c: pg.Client;
  beforeAll(async () => {
    c = await connect();
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../../src/styles/legacy.css'), path.join(out, 'legacy.css'));
  });
  afterAll(async () => {
    await c.end();
  });

  const write = (name: string, route: string, role: Role, session: Parameters<typeof Shell>[0]['session'], el: ReactElement) => {
    h.path = route;
    const html = renderToStaticMarkup(<Shell session={session}>{el}</Shell>);
    fs.writeFileSync(
      path.join(out, `${name}.html`),
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name}</title><link rel="stylesheet" href="/_preview/legacy.css"></head><body>${html}</body></html>`,
    );
    void role;
  };

  it('renders', async () => {
    const all = (await c.query('SELECT id FROM brand')).rows.map((r) => r.id as string);
    const scope = makeScope(all);
    const brands = (await listBrands(c, scope)).map((b) => ({ ...b, logoUrl: b.logoSha ? `/api/brands/${b.id}/logo` : null }));
    const catalog = await loadCatalog(c);
    const rows = recipeRows(catalog, scope);
    const items = await listIngredients(c, scope);
    const target = catalog.settings.target;
    const gmUser = { id: 'preview', clerkUserId: 'preview', email: null, name: 'Preview GM', role: 'gm' as Role };
    const nOf = (id: string) => rows.filter((r) => r.brandId === id).length;
    const cb = brands.map((b) => ({ id: b.id, name: b.name, code: b.code, color: b.color || '#BB5E1E', onSolid: palette(b.color || '#BB5E1E', b.inkColor).onSolid, logoUrl: b.logoUrl, cards: nOf(b.id) }));
    const mv = await menusVisible(c, scope);
    const session = (workspace: string | null) => ({
      name: 'Preview GM',
      role: 'gm' as Role,
      permissions: permissionsFor('gm'),
      menusVisible: mv,
      brands: cb,
      workspace: cb.find((b) => b.id === workspace) ?? null,
    });
    const ssem = brands.find((b) => b.legacyId === 'bssem')!;
    const ws = session(ssem.id);
    const names = Object.fromEntries(brands.map((b) => [b.id, b.name]));

    const tiles = brandTiles(brands, rows, target, (b) => {
      const p = palette(b.color || '#BB5E1E', b.inkColor);
      return { onSolid: p.onSolid, text: p.text };
    });
    write('brands', '/brands', 'gm', session(null), <BrandsScreen tiles={tiles} workspaceId="" target={target} />);
    write('dash', '/dash', 'gm', ws, <DashScreen d={dashData(rows, items, brands, catalog, target)} brandNames={names} />);
    write('recipes', '/recipes', 'gm', ws, <RecipesScreen rows={rows} brands={brands.map((b) => ({ id: b.id, name: b.name }))} workspaceId={ssem.id} target={target} />);

    const someMenu = rows.find((r) => r.type === 'menu' && r.nLines > 3)!;
    const detail = await recipeDetail(c, scope, someMenu.id);
    const brandOf = (id: string) => {
      const b = brands.find((x) => x.id === id)!;
      return { id: b.id, name: b.name, nameAr: b.nameAr, color: b.color || '#BB5E1E', ink: b.inkColor, logoUrl: b.logoUrl };
    };
    const bl = brands.map((b) => ({ id: b.id, name: b.name, code: b.code }));
    write('edit', `/edit/${someMenu.id}`, 'gm', ws, <EditScreen detail={detail} brand={brandOf(someMenu.brandId)} brands={bl} />);
    const locked = { ...detail, recipe: { ...detail.recipe, status: 'LOCKED' as const, lockedBy: 'Chef Preview', lockedAt: new Date(), history: [{ action: 'LOCK' as const, who: 'Chef Preview', at: new Date() }], costAtLock: { food: detail.view.cost.food, priceDate: '2026-10-09' } } };
    write('locked', `/edit/${someMenu.id}`, 'gm', ws, <EditScreen detail={locked} brand={brandOf(someMenu.brandId)} brands={bl} />);

    write('items', '/items', 'gm', ws, <ItemsScreen items={items.slice(0, 400)} brands={bl} priceDate={catalog.settings.priceDate} />);
    write('conv', '/conv', 'gm', ws, <ConvScreen items={items.map((i) => ({ id: i.id, code: i.code, name: i.name, uom: i.uom, price: i.price, conv: i.conv }))} used={{}} />);
    const settings = await getSettings(c);
    const sb = brands.map((b) => ({ id: b.id, code: b.code, name: b.name, color: b.color, logoUrl: b.logoUrl, locations: b.locations, cards: nOf(b.id), locked: 0 }));
    write('settings', '/settings', 'gm', ws, <SettingsScreen settings={settings} brands={sb} impact={rows.filter((r) => r.type === 'menu').slice(0, 15).map((r) => ({ ...r, brandName: names[r.brandId] ?? '' }))} />);
    write('health', '/health', 'gm', ws, <HealthScreen live={healthRows(catalog, scope, items).slice(0, 40)} flagged={items.filter((i) => i.flag).length} />);
    write('yields', '/yields', 'gm', ws, <YieldsScreen />);
    write('audit', '/audit', 'gm', ws, <AuditScreen initial={await listAudit(c, gmUser, auditQuery.parse({}))} />);
    write(
      'users',
      '/users',
      'gm',
      ws,
      <UsersScreen
        users={[
          { id: 'u1', name: 'Preview GM', email: 'gm@example.com', role: 'gm', banned: false, appUserId: 'x', active: true, brandIds: [], isYou: true },
          { id: 'u2', name: 'Head Chef', email: 'chef@example.com', role: 'chef', banned: false, appUserId: 'y', active: true, brandIds: [ssem.id], isYou: false },
          { id: 'u3', name: 'Suspended Person', email: 's@example.com', role: 'cook', banned: true, appUserId: 'z', active: false, brandIds: [], isYou: false },
          { id: 'u4', name: 'New Signup', email: 'n@example.com', role: null, banned: false, appUserId: null, active: true, brandIds: [], isYou: false },
        ]}
        brands={bl}
      />,
    );
    const ctx = { user: gmUser, scope, brands, workspaceId: ssem.id, menusVisible: mv };
    const today = { month: '2026-10', day: '10' };
    const pd = (view: 'day' | 'req' | 'month') => loadProd(c, ctx as never, catalog, { view, ...today, brand: ssem.id, loc: '*' });
    write('prod-day', '/prod', 'gm', ws, <ProdScreen data={await pd('day')} />);
    write('prod-req', '/prod', 'gm', ws, <ProdScreen data={await pd('req')} />);
    write('prod-month', '/prod', 'gm', ws, <ProdScreen data={await pd('month')} />);
    write('prep', '/prep', 'gm', ws, <PrepScreen data={await loadPrep(c, ctx as never, catalog, { ...today, loc: '*', weekday: 'SATURDAY' })} />);
    write('plan', '/plan', 'gm', ws, <PlanScreen data={await loadPlan(c, ctx as never, catalog)} />);
    write('backup', '/backup', 'gm', ws, <BackupScreen counts={{ items: items.length, recipes: rows.length, conv: items.filter((i) => i.conv).length, photos: 0, photoKb: 0 }} />);
  });
});
