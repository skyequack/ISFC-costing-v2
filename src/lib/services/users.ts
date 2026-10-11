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
export interface ClerkInviteLite {
  id: string;
  email: string;
  role: Role | null;
}
export interface ClerkPort {
  list(): Promise<ClerkUserLite[]>;
  get(id: string): Promise<ClerkUserLite>;
  setRole(id: string, role: Role): Promise<void>;
  ban(id: string): Promise<void>;
  unban(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Creates the invitation and returns its id. */
  invite(email: string, role: Role): Promise<string>;
  /** Pending invitations only. */
  listInvitations(): Promise<ClerkInviteLite[]>;
  revokeInvitation(id: string): Promise<void>;
}

const USERS_LOCK = 8_041_002;

const brandIdsIn = z.array(z.string().min(1).max(64)).max(40);
export const inviteIn = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  role: z.enum(ROLE_KEYS),
  brandIds: brandIdsIn.optional(),
});
export const invitePatchIn = z.object({ role: z.enum(ROLE_KEYS).optional(), brandIds: brandIdsIn.optional() });
export const userPatchIn = z.object({
  role: z.enum(ROLE_KEYS).optional(),
  brandIds: brandIdsIn.optional(),
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

export interface InviteRow {
  id: string;
  email: string;
  role: Role | null;
  brandIds: string[];
}

/** Pending invitations (D-78) with the brands promised to each. Clerk failing must not break the Users tab: `failed` is set instead. */
export async function listInvites(
  db: Queryable,
  port: ClerkPort,
  actor: SessionUser,
): Promise<{ invites: InviteRow[]; failed: boolean }> {
  needUsers(actor);
  const [inv, stored] = await Promise.all([
    port.listInvitations().then(
      (r) => r,
      () => null,
    ),
    db.query(
      'SELECT email, array_agg(brand_id ORDER BY brand_id) AS brand_ids FROM invite_brand_access GROUP BY email',
    ),
  ]);
  if (!inv) return { invites: [], failed: true };
  // Brands promised to an invitation that no longer exists (expired, revoked in Clerk, accepted under another email) would
  // block deleting the brand and could be granted to a later invitation of the same email: drop them.
  const pending = inv.map((i) => i.email.toLowerCase());
  if (stored.rows.some((r) => !pending.includes(r.email as string)))
    await db.query('DELETE FROM invite_brand_access WHERE email <> ALL($1::text[])', [pending]);
  const byEmail = new Map(stored.rows.map((r) => [r.email as string, r.brand_ids as string[]]));
  return {
    invites: inv.map((i) => ({ ...i, brandIds: i.role === 'gm' ? [] : (byEmail.get(i.email.toLowerCase()) ?? []) })),
    failed: false,
  };
}

async function assertBrands(tx: Queryable, brandIds: string[]): Promise<string[]> {
  const ids = [...new Set(brandIds)];
  if (ids.length) {
    const ok = await tx.query('SELECT count(*)::int AS n FROM brand WHERE id = ANY($1::text[])', [ids]);
    if (ok.rows[0]!.n !== ids.length) throw new ApiError('bad_request', 'Unknown brand');
  }
  return ids;
}

async function storeInviteBrands(tx: Queryable, email: string, brandIds: string[]): Promise<void> {
  const e = email.toLowerCase();
  await tx.query('DELETE FROM invite_brand_access WHERE email = $1', [e]);
  if (brandIds.length)
    await tx.query('INSERT INTO invite_brand_access (email, brand_id) SELECT $1, unnest($2::text[])', [e, brandIds]);
}

/** The invitation id is only ever accepted when it is in a fresh Clerk pending list (never passed to Clerk blind). */
async function findPending(port: ClerkPort, id: string): Promise<ClerkInviteLite> {
  const inv = (await port.listInvitations()).find((i) => i.id === id);
  if (!inv) throw new ApiError('not_found', 'Not found');
  return inv;
}

/** Clerk refuses to revoke an invitation that was accepted or revoked a moment ago: report that as a conflict, not a 500. */
async function revokeOrConflict(port: ClerkPort, id: string): Promise<void> {
  try {
    await port.revokeInvitation(id);
  } catch {
    throw new ApiError('conflict', 'This invitation is no longer pending – reload the page');
  }
}

const brandNote = (n: number) => (n ? ` · ${n} brand(s)` : '');

export async function inviteUser(
  tx: Queryable,
  port: ClerkPort,
  actor: SessionUser,
  input: z.output<typeof inviteIn>,
): Promise<void> {
  needUsers(actor);
  await tx.query('SELECT pg_advisory_xact_lock($1)', [USERS_LOCK]);
  const brandIds = input.role === 'gm' ? [] : await assertBrands(tx, input.brandIds ?? []);
  // Clerk returns an existing pending invitation unchanged (ignoreExisting), so a different role must go through Edit access
  const existing = (await port.listInvitations()).find((i) => i.email.toLowerCase() === input.email);
  if (existing && existing.role !== input.role)
    throw new ApiError('conflict', 'This email already has a pending invitation – use Edit access to change it');
  const id = existing ? existing.id : await port.invite(input.email, input.role);
  try {
    await storeInviteBrands(tx, input.email, brandIds);
    await appendAudit(
      tx,
      actor,
      'Invited user',
      `${input.email} · ${ROLES[input.role].label}${brandNote(brandIds.length)}`,
    );
  } catch (e) {
    if (!existing) await port.revokeInvitation(id).catch(() => undefined); // compensate: nothing was recorded
    throw e;
  }
}

export async function revokeInvite(tx: Queryable, port: ClerkPort, actor: SessionUser, id: string): Promise<void> {
  needUsers(actor);
  await tx.query('SELECT pg_advisory_xact_lock($1)', [USERS_LOCK]);
  const inv = await findPending(port, id);
  await tx.query('DELETE FROM invite_brand_access WHERE email = $1', [inv.email.toLowerCase()]);
  await appendAudit(tx, actor, 'Revoked invite', inv.email);
  await revokeOrConflict(port, inv.id); // last: if this throws the transaction rolls back and nothing changed
}

/**
 * Edit access on a pending invitation (D-80). Brands live here, so a brands-only edit sends nothing. A role change
 * cannot be edited in Clerk: the old invitation is revoked and a new one created (a second email, a new id), and the
 * old one is restored if the create fails.
 */
export async function updateInvite(
  tx: Queryable,
  port: ClerkPort,
  actor: SessionUser,
  id: string,
  input: z.output<typeof invitePatchIn>,
): Promise<{ id: string }> {
  needUsers(actor);
  await tx.query('SELECT pg_advisory_xact_lock($1)', [USERS_LOCK]);
  const inv = await findPending(port, id);
  const role = input.role ?? inv.role;
  const roleChange = input.role !== undefined && input.role !== inv.role;
  const brandIds =
    role === 'gm' ? [] : input.brandIds !== undefined ? await assertBrands(tx, input.brandIds) : undefined;
  let newId = inv.id;
  if (roleChange) {
    await revokeOrConflict(port, inv.id); // Clerk would hand back the old invitation if we created first
    try {
      newId = await port.invite(inv.email, input.role!);
    } catch (e) {
      if (inv.role) await port.invite(inv.email, inv.role).catch(() => undefined);
      throw e;
    }
  }
  try {
    if (brandIds !== undefined) await storeInviteBrands(tx, inv.email, brandIds);
    await appendAudit(
      tx,
      actor,
      'Updated invite',
      `${inv.email} · ${ROLES[role ?? 'viewer'].label}${brandIds ? brandNote(brandIds.length) : ''}`,
    );
  } catch (e) {
    if (roleChange) {
      await port.revokeInvitation(newId).catch(() => undefined);
      if (inv.role) await port.invite(inv.email, inv.role).catch(() => undefined);
    }
    throw e;
  }
  return { id: newId };
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
  if (input.brandIds?.length) await assertBrands(tx, input.brandIds);
  const previousRole = target.role;
  if (roleChange) await port.setRole(target.id, input.role!); // Clerk first (authoritative) ...
  try {
    const appId = await ensureAppUser(tx, target); // ... then our database
    if (input.name) await tx.query('UPDATE app_user SET name = $2 WHERE id = $1', [appId, input.name]);
    if (roleChange) await tx.query('UPDATE app_user SET last_role_seen = $2 WHERE id = $1', [appId, input.role]);
    if (input.brandIds) {
      await tx.query('DELETE FROM user_brand_access WHERE user_id = $1', [appId]);
      if (input.brandIds.length)
        await tx.query('INSERT INTO user_brand_access (user_id, brand_id) SELECT $1, unnest($2::text[])', [
          appId,
          [...new Set(input.brandIds)],
        ]);
    }
    const label = ROLES[input.role ?? target.role ?? 'viewer'].label;
    await appendAudit(
      tx,
      actor,
      'Updated user',
      `${input.name ?? target.name} · ${label}${input.brandIds ? ` · ${input.brandIds.length} brand(s)` : ''}`,
    );
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

export async function setUserBanned(
  tx: Queryable,
  port: ClerkPort,
  actor: SessionUser,
  clerkUserId: string,
  banned: boolean,
): Promise<void> {
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
export async function deleteUser(
  tx: Queryable,
  port: ClerkPort,
  actor: SessionUser,
  clerkUserId: string,
): Promise<void> {
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
