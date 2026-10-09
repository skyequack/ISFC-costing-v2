import { db } from '@/lib/db/client';
import { can } from '@/lib/permissions';
import { pageCtx } from '@/lib/page';
import { auditQuery, listAudit } from '@/lib/services/audit';
import { AuditScreen } from '@/components/screens/SimpleScreens';

export default async function Page() {
  const ctx = await pageCtx();
  if (!can(ctx.user.role, 'audit.view')) return <div className="note r">Your role cannot view the activity log.</div>;
  const initial = await listAudit(db, ctx.user, auditQuery.parse({}));
  return <AuditScreen initial={initial} />;
}
