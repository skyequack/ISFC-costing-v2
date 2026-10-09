import { auth, clerkClient } from '@clerk/nextjs/server';
import type { User as ClerkUser } from '@clerk/nextjs/server';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/client';
import { getEnv } from '../env';
import { log } from '../logger';
import { isRole, type Role } from '../permissions';
import type { SessionResult } from './types';

function verifiedPrimaryEmail(u: ClerkUser): string | null {
  const primary = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId);
  return primary && primary.verification?.status === 'verified' ? primary.emailAddress.toLowerCase() : null;
}

function displayName(u: ClerkUser): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return full || u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress || 'User';
}

/** D-22: INITIAL_GM_EMAILS matches VERIFIED primary emails only; writes publicMetadata.role='gm' (idempotent). */
async function bootstrapGm(clerkUser: ClerkUser): Promise<Role | null> {
  const email = verifiedPrimaryEmail(clerkUser);
  if (!email || !getEnv().initialGmEmails.includes(email)) return null;
  const client = await clerkClient();
  await client.users.updateUserMetadata(clerkUser.id, { publicMetadata: { role: 'gm' } });
  log('info', 'initial GM bootstrapped', { clerkUserId: clerkUser.id });
  return 'gm';
}

async function provision(clerkUser: ClerkUser, role: Role | null) {
  const data = {
    email: verifiedPrimaryEmail(clerkUser),
    name: displayName(clerkUser),
    lastRoleSeen: role,
  };
  const run = () =>
    prisma.user.upsert({
      where: { clerkUserId: clerkUser.id },
      create: { clerkUserId: clerkUser.id, ...data },
      update: {},
    });
  try {
    return await run();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return run(); // concurrent first request
    throw e;
  }
}

/**
 * Resolve the signed-in app user. Shared by withAuth (API) and server layouts.
 * Role: session claim first (speed); if absent, read Clerk metadata once; if still absent, try the
 * INITIAL_GM_EMAILS bootstrap; otherwise 'pending' (never viewer). Inactive users are rejected on every request.
 */
export async function getSession(): Promise<SessionResult> {
  const { userId, sessionClaims } = await auth();
  if (!userId) return { status: 'anonymous' };

  let role: Role | null = isRole(sessionClaims?.role) ? sessionClaims.role : null;
  let row = await prisma.user.findUnique({ where: { clerkUserId: userId } });
  let clerkUser: ClerkUser | null = null;

  if (!row || !role) {
    clerkUser = await (await clerkClient()).users.getUser(userId);
    if (!role) {
      const meta = clerkUser.publicMetadata?.role;
      role = isRole(meta) ? meta : await bootstrapGm(clerkUser);
    }
    if (!row) row = await provision(clerkUser, role);
  }

  if (!row.active) return { status: 'inactive', clerkUserId: userId };
  if (!role) return { status: 'pending', clerkUserId: userId };
  if (row.lastRoleSeen !== role) {
    await prisma.user.update({ where: { id: row.id }, data: { lastRoleSeen: role } }); // diagnostics only
  }
  return { status: 'ok', user: { id: row.id, clerkUserId: userId, email: row.email, name: row.name, role } };
}
