import { z } from 'zod';
import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { appendAudit } from '../db/repo/audit';
import { ApiError } from '../errors';
import { can, isRole, ROLES, ROLE_KEYS, type Role } from '../permissions';

/** The slice of Clerk the Users tab needs, so the rules can be tested without the network (D-31). */
export interface ClerkUserLite {
  id: string;
  name: string;
  email: string | null;
  role: Role | null;
  banned: boolean;
}
export interface ClerkPort {
  list(): Promise<ClerkUserLite[]>;
  get(id: string): Promise<ClerkUserLite>;
  setRole(id: string, role: Role): Promise<void>;
  ban(id: string): Promise<void>;
  unban(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  invite(email: string, role: Role): Promise<void>;
}

const USERS_LOCK = 8_041_002;

export const inviteIn = z.object({ email: z.string().trim().toLowerCase().email().max(200), role: z.enum(ROLE_KEYS) });
export const userPatchIn = z.object({
  role: z.enum(ROLE_KEYS).optional(),
  brandIds: z.array(z.string().min(1).max(64)).max(40).optional(),
  name: z.string().trim().min(1).max(120).optional(),
});

function needUsers(user: SessionUser): void {
  if (!can(user.role, 'users.manage')) throw new ApiError('forbidden', 'Only the General Manager can manage users');
}

export interface UserRow extends ClerkUserLite {
  appUserId: string | null;
  active: boolean;
  brandIds: string[];
  isYou: boolean;
}

export async function listUsers(db: Queryable, port: ClerkPort, actor: SessionUser): Promise<UserRow[]> {
  needUsers(actor);
  const clerk = await port.list();
  const app = await db.query(
    `SELECT u.id, u.clerk_user_id, u.active, u.name,
            coalesce((SELECT array_agg(a.brand_id ORDER BY a.brand_id) FROM user_brand_access a WHERE a.user_id = u.id), '{}') AS brand_ids
       FROM app_user u`,
  );
  const byClerk = new Map(app.rows.map((r) => [r.clerk_user_id as string, r]));
  return clerk.map((c) => {
    const a = byClerk.get(c.id);
    return {
      ...c,
      name: (a?.name as string | undefined) ?? c.name,
      appUserId: (a?.id as string | undefined) ?? null,
      active: a ? (a.active as boolean) && !c.banned : !c.banned,
      brandIds: (a?.brand_ids as string[] | undefined) ?? [],
      isYou: c.id === actor.clerkUserId,
    };
  });
}

/** Active GMs according to a FRESH Clerk read (never the cached session claim), optionally excluding one user. */
async function otherActiveGms(port: ClerkPort, excludeId: string): Promise<number> {
  return (await port.list()).filter((u) => u.role === 'gm' && !u.banned && u.id !== excludeId).length;
}

async function ensureAppUser(tx: Queryable, u: ClerkUserLite): Promise<string> {
  const { rows } = await tx.query(
    `INSERT INTO app_user (clerk_user_id, email, name, last_role_seen) VALUES ($1,$2,$3,$4)
     ON CONFLICT (clerk_user_id) DO UPDATE SET clerk_user_id = EXCLUDED.clerk_user_id RETURNING id`,
    [u.id, u.email, u.name, u.role],
  );
  return rows[0]!.id as string;
}

export async function inviteUser(tx: Queryable, port: ClerkPort, actor: SessionUser, input: z.output<typeof inviteIn>): Promise<void> {
  needUsers(actor);
  await port.invite(input.email, input.role);
  await appendAudit(tx, actor, 'Invited user', `${input.email} · ${ROLES[input.role].label}`);
}

export async function updateUser(
  tx: Queryable,
  port: ClerkPort,
  actor: SessionUser,
  clerkUserId: string,
  input: z.output<typeof userPatchIn>,
): Promise<void> {
  needUsers(actor);
  await tx.query('SELECT pg_advisory_xact_lock($1)', [USERS_LOCK]);
  const target = await port.get(clerkUserId); // fresh read
  const roleChange = input.role !== undefined && input.role !== target.role;
  if (roleChange) {
    if (target.id === actor.clerkUserId) throw new ApiError('forbidden', 'You cannot change your own role');
    if (target.role === 'gm' && !target.banned && (await otherActiveGms(port, target.id)) === 0)
      throw new ApiError('conflict', 'There must always be at least one active General Manager');
  }
  if (input.brandIds?.length) {
    const ok = await tx.query('SELECT count(*)::int AS n FROM brand WHERE id = ANY($1::text[])', [[...new Set(input.brandIds)]]);
    if (ok.rows[0]!.n !== new Set(input.brandIds).size) throw new ApiError('bad_request', 'Unknown brand');
  }
  const previousRole = target.role;
  if (roleChange) await port.setRole(target.id, input.role!); // Clerk first (authoritative) ...
  try {
    const appId = await ensureAppUser(tx, target); // ... then our database
    if (input.name) await tx.query('UPDATE app_user SET name = $2 WHERE id = $1', [appId, input.name]);
    if (roleChange) await tx.query('UPDATE app_user SET last_role_seen = $2 WHERE id = $1', [appId, input.role]);
    if (input.brandIds) {
      await tx.query('DELETE FROM user_brand_access WHERE user_id = $1', [appId]);
      if (input.brandIds.length)
        await tx.query('INSERT INTO user_brand_access (user_id, brand_id) SELECT $1, unnest($2::text[])', [appId, [...new Set(input.brandIds)]]);
    }
    const label = ROLES[input.role ?? target.role ?? 'viewer'].label;
    await appendAudit(tx, actor, 'Updated user', `${input.name ?? target.name} · ${label}${input.brandIds ? ` · ${input.brandIds.length} brand(s)` : ''}`);
  } catch (e) {
    if (roleChange && previousRole) await port.setRole(target.id, previousRole).catch(() => undefined); // compensate
    throw e;
  }
}

async function guardRemoval(port: ClerkPort, actor: SessionUser, target: ClerkUserLite, verb: string): Promise<void> {
  if (target.id === actor.clerkUserId) throw new ApiError('forbidden', `You cannot ${verb} yourself`);
  if (target.role === 'gm' && !target.banned && (await otherActiveGms(port, target.id)) === 0)
    throw new ApiError('conflict', 'There must always be at least one active General Manager');
}

export async function setUserBanned(tx: Queryable, port: ClerkPort, actor: SessionUser, clerkUserId: string, banned: boolean): Promise<void> {
  needUsers(actor);
  await tx.query('SELECT pg_advisory_xact_lock($1)', [USERS_LOCK]);
  const target = await port.get(clerkUserId);
  if (banned) await guardRemoval(port, actor, target, 'suspend');
  if (banned) await port.ban(target.id);
  else await port.unban(target.id);
  try {
    const appId = await ensureAppUser(tx, target);
    await tx.query('UPDATE app_user SET active = $2 WHERE id = $1', [appId, !banned]);
    await appendAudit(tx, actor, banned ? 'Suspended user' : 'Restored user', target.name);
  } catch (e) {
    await (banned ? port.unban(target.id) : port.ban(target.id)).catch(() => undefined);
    throw e;
  }
}

/** Soft-delete: the app row is kept (inactive) so audit snapshots keep their meaning; then the Clerk account goes. */
export async function deleteUser(tx: Queryable, port: ClerkPort, actor: SessionUser, clerkUserId: string): Promise<void> {
  needUsers(actor);
  await tx.query('SELECT pg_advisory_xact_lock($1)', [USERS_LOCK]);
  const target = await port.get(clerkUserId);
  await guardRemoval(port, actor, target, 'delete');
  const appId = await ensureAppUser(tx, target);
  await tx.query('UPDATE app_user SET active = false WHERE id = $1', [appId]);
  await tx.query('DELETE FROM user_brand_access WHERE user_id = $1', [appId]);
  await appendAudit(tx, actor, 'Deleted user', target.name);
  await port.remove(target.id); // last: if this throws the transaction rolls back and nothing changed
}

export { isRole };
