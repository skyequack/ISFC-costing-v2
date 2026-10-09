import { db } from '@/lib/db/client';
import { clerkPort } from '@/lib/auth/clerk-port';
import { can } from '@/lib/permissions';
import { pageCtx } from '@/lib/page';
import { listUsers } from '@/lib/services/users';
import { UsersScreen } from '@/components/screens/UsersScreen';

export default async function Page() {
  const ctx = await pageCtx();
  if (!can(ctx.user.role, 'users.manage')) return <div className="note r">Only a General Manager can manage users.</div>;
  const users = await listUsers(db, clerkPort(), ctx.user);
  return <UsersScreen users={users} brands={ctx.brands.map((b) => ({ id: b.id, name: b.name, code: b.code }))} />;
}
