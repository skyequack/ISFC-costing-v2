import { clerkClient } from '@clerk/nextjs/server';
import type { User } from '@clerk/nextjs/server';
import { isRole } from '../permissions';
import type { ClerkPort, ClerkUserLite } from '../services/users';

function lite(u: User): ClerkUserLite {
  const primary = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId);
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  const meta = u.publicMetadata?.role;
  return {
    id: u.id,
    name: full || primary?.emailAddress || 'User',
    email: primary?.emailAddress ?? null,
    role: isRole(meta) ? meta : null,
    banned: u.banned,
  };
}

/** Real Clerk Backend API adapter for the Users tab (D-31). Tests use an in-memory ClerkPort instead. */
export function clerkPort(): ClerkPort {
  return {
    async list() {
      const c = await clerkClient();
      const out: ClerkUserLite[] = [];
      for (let offset = 0; offset < 2000; offset += 100) {
        const page = await c.users.getUserList({ limit: 100, offset, orderBy: '+created_at' });
        out.push(...page.data.map(lite));
        if (page.data.length < 100) break;
      }
      return out;
    },
    async get(id) {
      return lite(await (await clerkClient()).users.getUser(id));
    },
    async setRole(id, role) {
      await (await clerkClient()).users.updateUserMetadata(id, { publicMetadata: { role } });
    },
    async ban(id) {
      await (await clerkClient()).users.banUser(id);
    },
    async unban(id) {
      await (await clerkClient()).users.unbanUser(id);
    },
    async remove(id) {
      await (await clerkClient()).users.deleteUser(id);
    },
    async invite(email, role) {
      await (
        await clerkClient()
      ).invitations.createInvitation({
        emailAddress: email,
        publicMetadata: { role },
        ignoreExisting: true,
      });
    },
  };
}
