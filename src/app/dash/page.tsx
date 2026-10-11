import { notFound } from 'next/navigation';
import { db } from '@/lib/db/client';
import { listIngredients } from '@/lib/db/repo/ingredients';
import { ApiError } from '@/lib/errors';
import { pageCatalog, pageCtx } from '@/lib/page';
import { dashData } from '@/lib/screens/dash';
import { dashFilters, dashRows, loadDashAnalytics, type DashFilters } from '@/lib/services/dash';
import { DashScreen } from '@/components/screens/DashScreen';

type SP = { brand?: string; loc?: string; client?: string; from?: string; to?: string };

/** Filters live in the URL (D-65). Unreadable dates fall back to "all" with a message; a brand or site outside the caller's access is a 404. */
export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const parsed = dashFilters.safeParse({
    brand: sp.brand || '*',
    loc: sp.loc || '*',
    client: sp.client || '*',
    from: sp.from || undefined,
    to: sp.to || undefined,
  });
  const filters: DashFilters = parsed.success
    ? parsed.data
    : { brand: sp.brand || '*', loc: sp.loc || '*', client: sp.client || '*' };
  const filterError = parsed.success ? undefined : (parsed.error.issues[0]?.message ?? 'Invalid filters');
  const ctx = await pageCtx();
  const catalog = await pageCatalog();
  const allItems = await listIngredients(db, ctx.scope);
  // The Ingredients KPI follows the brand filter (D-84): the brand's own ingredients plus the shared ones (no brand link).
  const items =
    filters.brand === '*'
      ? allItems
      : allItems.filter((i) => i.brandIds.length === 0 || i.brandIds.includes(filters.brand));
  const rows = dashRows(catalog, ctx, filters.brand);
  const d = dashData(rows, items, ctx.brands, catalog, catalog.settings.target);
  let a;
  try {
    a = await loadDashAnalytics(db, ctx, catalog, filters, rows);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'not_found') notFound();
    throw e;
  }
  return (
    <DashScreen
      d={d}
      a={a}
      filterError={filterError}
      brandNames={Object.fromEntries(ctx.brands.map((b) => [b.id, b.name]))}
    />
  );
}
