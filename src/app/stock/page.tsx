import { notFound } from 'next/navigation';
import { db } from '@/lib/db/client';
import { ApiError } from '@/lib/errors';
import { pageCtx } from '@/lib/page';
import { loadStockGrid, stockDate, type StockKind } from '@/lib/services/stock';
import { StockScreen } from '@/components/screens/StockScreen';
import { RedirectTodayDate } from '@/components/shared/Today';

type SP = { site?: string; date?: string; kind?: string };

/** Counts and receipts per site and day (D-73). Open to every role; only stock.edit may change anything (the server checks). */
export default async function Page({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const ctx = await pageCtx();
  const kind: StockKind = sp.kind === 'receipt' ? 'receipt' : 'count';
  const date = stockDate.safeParse(sp.date);
  if (!date.success) return <RedirectTodayDate base="/stock" params={{ site: sp.site ?? '', kind }} />;
  try {
    const grid = await loadStockGrid(db, ctx.scope, { site: sp.site ?? '', date: date.data, kind });
    return <StockScreen grid={grid} />;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'not_found') notFound();
    throw e;
  }
}
