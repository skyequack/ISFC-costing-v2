import { z } from 'zod';
import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { appendAudit } from '../db/repo/audit';
import { getClient } from '../db/repo/clients';
import { assertBrandVisible, type BrandScope } from '../db/scope';
import { ApiError } from '../errors';
import { can } from '../permissions';

function needClients(user: SessionUser): void {
  if (!can(user.role, 'clients.edit'))
    throw new ApiError('forbidden', 'Only the General Manager and the Cost Controller can manage clients');
}

export const clientName = z.string().trim().min(1).max(80);
export const clientCreateIn = z.object({ name: clientName });
export const clientPatchIn = z
  .object({
    name: clientName.optional(),
    active: z.boolean().optional(),
    /** optimistic concurrency: the version the editor last read */
    version: z.number().int().min(0),
  })
  .refine((v) => v.name !== undefined || v.active !== undefined, 'Nothing to change');

async function assertNameFree(tx: Queryable, brandId: string, name: string, exceptId?: string): Promise<void> {
  const r = await tx.query(
    'SELECT 1 FROM client WHERE brand_id = $1 AND lower(name) = lower($2) AND id IS DISTINCT FROM $3',
    [brandId, name, exceptId ?? null],
  );
  if (r.rows[0]) throw new ApiError('conflict', `${name} already exists in this brand`);
}

async function brandName(tx: Queryable, id: string): Promise<string> {
  return ((await tx.query('SELECT name FROM brand WHERE id = $1', [id])).rows[0]?.name as string | undefined) ?? '';
}

export async function createClient(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  brandId: string,
  input: z.output<typeof clientCreateIn>,
): Promise<string> {
  needClients(user);
  assertBrandVisible(scope, brandId);
  await assertNameFree(tx, brandId, input.name);
  const id = (await tx.query('INSERT INTO client (brand_id, name) VALUES ($1, $2) RETURNING id', [brandId, input.name]))
    .rows[0]!.id as string;
  await appendAudit(tx, user, 'Added client', `${input.name} (${await brandName(tx, brandId)})`);
  return id;
}

/** Rename and/or (de)activate. Rows reference the id, so a rename follows everywhere; a stale version is a 409. */
export async function updateClient(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  id: string,
  input: z.output<typeof clientPatchIn>,
): Promise<void> {
  needClients(user);
  const cur = await getClient(tx, scope, id, 'update');
  if (cur.version !== input.version)
    throw new ApiError('conflict', 'This client was changed by someone else - reload and try again');
  const name = input.name ?? cur.name;
  if (name.toLowerCase() !== cur.name.toLowerCase()) await assertNameFree(tx, cur.brandId, name, id);
  const active = input.active ?? cur.active;
  await tx.query('UPDATE client SET name = $2, active = $3, version = version + 1 WHERE id = $1', [id, name, active]);
  const what: string[] = [];
  if (name !== cur.name) what.push(`renamed from ${cur.name}`);
  if (active !== cur.active) what.push(active ? 'reactivated' : 'deactivated');
  await appendAudit(
    tx,
    user,
    'Edited client',
    `${name} (${await brandName(tx, cur.brandId)}): ${what.join(', ') || 'no change'}`,
  );
}

/** Only a client no production row refers to can be deleted; otherwise deactivate it (D-71). */
export async function deleteClient(tx: Queryable, user: SessionUser, scope: BrandScope, id: string): Promise<void> {
  needClients(user);
  const cur = await getClient(tx, scope, id, 'update');
  const n = Number(
    (await tx.query('SELECT count(*) AS n FROM production_entry WHERE client_id = $1', [id])).rows[0]!.n,
  );
  if (n)
    throw new ApiError('conflict', `${cur.name} has ${n} production row${n === 1 ? '' : 's'} - deactivate it instead`, {
      rows: n,
    });
  await tx.query('DELETE FROM client WHERE id = $1', [id]);
  await appendAudit(tx, user, 'Removed client', `${cur.name} (${await brandName(tx, cur.brandId)})`);
}

/**
 * A production row may name a client only when the client belongs to the card's brand (D-71, no foreign key).
 * '' (unassigned) always passes. 404 for an unknown client, 422 for one of another brand. The client row is locked
 * (FOR SHARE) until the transaction ends so it cannot be deleted underneath the row being written.
 *
 * An inactive client takes no NEW rows, but rows it already has can still be changed or cleared: `existingKey` names the
 * row being written, and the inactive check is skipped when that row exists. Otherwise a deactivated client's numbers
 * would be stuck for good.
 */
export async function assertClientForCard(
  tx: Queryable,
  scope: BrandScope,
  clientId: string,
  cardBrandId: string,
  existingKey?: { month: string; day: string; location: string; recipeCode: string },
): Promise<void> {
  if (clientId === '') return;
  const c = await getClient(tx, scope, clientId, 'share');
  if (c.brandId !== cardBrandId) throw new ApiError('unprocessable', 'That client belongs to another brand');
  if (c.active) return;
  const has =
    existingKey &&
    (
      await tx.query(
        'SELECT 1 FROM production_entry WHERE month = $1 AND day = $2 AND location = $3 AND client_id = $4 AND recipe_code = $5',
        [existingKey.month, existingKey.day, existingKey.location, clientId, existingKey.recipeCode],
      )
    ).rows[0];
  if (!has) throw new ApiError('unprocessable', `${c.name} is inactive - reactivate it first`);
}

/**
 * A client choice from a URL or an export query: '*' (every client), 'none' (unassigned) or a client id the caller can see.
 * Anything else is a 404, so an export never silently covers a different set of rows than the screen did.
 */
export async function resolveClientChoice(db: Queryable, scope: BrandScope, choice: string): Promise<string> {
  if (choice === '*' || choice === 'none') return choice;
  await getClient(db, scope, choice);
  return choice;
}
