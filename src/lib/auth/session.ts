import { auth, clerkClient } from '@clerk/nextjs/server';
import type { User as ClerkUser } from '@clerk/nextjs/server';
import { db } from '../db/client';
import { camelRow } from '../db/rows';
import { attachScope } from '../db/scope';
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

interface UserRow {
  id: string;
  clerkUserId: string;
  email: string | null;
  name: string;
  active: boolean;
  lastRoleSeen: string | null;
}

const USER_COLUMNS = 'id, clerk_user_id, email, name, active, last_role_seen';

async function findUser(clerkUserId: string): Promise<UserRow | null> {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM app_user WHERE clerk_user_id = $1`, [clerkUserId]);
  return rows[0] ? camelRow<UserRow>(rows[0]) : null;
}

/**
 * Same lookup plus the caller's visible brand ids, in one round trip. Only usable when the role is already known
 * (the session-token claim): GM sees every brand, everyone else their user_brand_access rows (same rule as visibleBrandIds).
 */
async function findUserWithScope(
  clerkUserId: string,
  role: Role,
): Promise<{ row: UserRow; brandIds: string[] } | null> {
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS.split(', ')
      .map((c) => `u.${c}`)
      .join(', ')},
            CASE WHEN $2 = 'gm' THEN array(SELECT id::text FROM brand ORDER BY id)
                 ELSE array(SELECT brand_id::text FROM user_brand_access WHERE user_id = u.id ORDER BY brand_id) END AS brand_ids
       FROM app_user u WHERE u.clerk_user_id = $1`,
    [clerkUserId, role],
  );
  if (!rows[0]) return null;
  const { brand_ids, ...rest } = rows[0] as Record<string, unknown>;
  return { row: camelRow<UserRow>(rest), brandIds: brand_ids as string[] };
}

/** Race-safe first-login provisioning: one statement, so two parallel first requests both get the same row. */
async function provision(clerkUser: ClerkUser, role: Role | null): Promise<UserRow> {
  const { rows } = await db.query(
    `INSERT INTO app_user (clerk_user_id, email, name, last_role_seen) VALUES ($1, $2, $3, $4)
     ON CONFLICT (clerk_user_id) DO UPDATE SET clerk_user_id = EXCLUDED.clerk_user_id
     RETURNING ${USER_COLUMNS}`,
    [clerkUser.id, verifiedPrimaryEmail(clerkUser), displayName(clerkUser), role],
  );
  return camelRow<UserRow>(rows[0] as Record<string, unknown>);
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
  let row: UserRow | null;
  let brandIds: string[] | null = null;
  if (role) {
    const found = await findUserWithScope(userId, role);
    row = found?.row ?? null;
    brandIds = found?.brandIds ?? null;
  } else {
    row = await findUser(userId);
  }
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
    await db.query('UPDATE app_user SET last_role_seen = $1 WHERE id = $2', [role, row.id]); // diagnostics only
  }
  const user = { id: row.id, clerkUserId: userId, email: row.email, name: row.name, role };
  if (brandIds) attachScope(user, brandIds);
  return { status: 'ok', user };
}
