import { MENU_DAYS } from '@/data';
import { db } from '@/lib/db/client';
import { pageCatalog, pageCtx } from '@/lib/page';
import { defaultWeekday, loadPrep } from '@/lib/screens/plan';
import { PrepScreen } from '@/components/screens/PrepScreen';
import { RedirectToday } from '@/components/shared/Today';

type SP = { m?: string; d?: string; l?: string; wd?: string };

export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const ctx = await pageCtx();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(sp.m ?? '') || !/^(0[1-9]|[12]\d|3[01])$/.test(sp.d ?? ''))
    return <RedirectToday base="/prep" params={{ l: sp.l ?? '*', ...(sp.wd ? { wd: sp.wd } : {}) }} />;
  const weekday = sp.wd && MENU_DAYS.includes(sp.wd) ? sp.wd : defaultWeekday(sp.m!, sp.d!);
  const catalog = await pageCatalog();
  const data = await loadPrep(db, ctx, catalog, { month: sp.m!, day: sp.d!, loc: sp.l || '*', weekday });
  return <PrepScreen data={data} />;
}
