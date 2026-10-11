import { daysIn, pad2 } from '@/domain/production/day';
import { db } from '@/lib/db/client';
import { pageCatalog, pageCtx } from '@/lib/page';
import { loadProd, type ProdView } from '@/lib/screens/prod';
import { ProdScreen } from '@/components/screens/ProdScreen';
import { RedirectToday } from '@/components/shared/Today';

type SP = { v?: string; m?: string; d?: string; b?: string; l?: string; c?: string };

export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const ctx = await pageCtx();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(sp.m ?? '') || !/^(0[1-9]|[12]\d|3[01])$/.test(sp.d ?? ''))
    return <RedirectToday base="/prod" params={{ v: sp.v ?? 'day', b: sp.b ?? '*', l: sp.l ?? '*', c: sp.c ?? '*' }} />;
  const view: ProdView = sp.v === 'req' || sp.v === 'month' ? sp.v : 'day';
  const catalog = await pageCatalog();
  const brand = sp.b && ctx.brands.some((b) => b.id === sp.b) ? sp.b : '*';
  const nd = daysIn(sp.m!);
  const day = Number(sp.d) > nd ? pad2(nd) : sp.d!; // legacy let the day exceed the month length
  const data = await loadProd(db, ctx, catalog, {
    view,
    month: sp.m!,
    day,
    brand,
    loc: sp.l || '*',
    client: sp.c || '*',
  });
  return <ProdScreen data={data} />;
}
