import { db } from '@/lib/db/client';
import { pageCatalog, pageCtx } from '@/lib/page';
import { loadPlan } from '@/lib/screens/plan';
import { PlanScreen } from '@/components/screens/PlanScreen';

export default async function Page() {
  const ctx = await pageCtx();
  if (!ctx.menusVisible)
    return (
      <div className="note r">
        <b>Menu plans belong to the SSEM project.</b> Switch the workspace to SSEM to open them.
      </div>
    );
  const catalog = await pageCatalog();
  return <PlanScreen data={await loadPlan(db, ctx, catalog)} />;
}
