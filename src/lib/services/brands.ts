import { z } from 'zod';
import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { appendAudit } from '../db/repo/audit';
import { ApiError } from '../errors';
import { can } from '../permissions';

function needBrands(user: SessionUser): void {
  if (!can(user.role, 'brands.edit')) throw new ApiError('forbidden', 'Only the General Manager can manage brands');
}

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colour must look like #BB5E1E');
export const brandCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{1,4}$/, 'prefix is 1-4 letters or digits');

export const brandCreateIn = z.object({
  name: z.string().trim().min(1).max(80),
  code: brandCode.optional(),
  color: hex.optional(),
});

export const siteName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((s) => !s.includes('|'), 'a site name cannot contain |');

export const brandPatchIn = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  code: brandCode.optional(),
  color: hex.optional(),
  nameAr: z.string().trim().max(80).nullable().optional(),
  inkColor: hex.nullable().optional(),
  /** D-52: the full list of sites after the edit, with explicit renames so stored rows follow. */
  locations: z.array(siteName).max(30).optional(),
  renamedSites: z
    .array(z.object({ from: siteName, to: siteName }))
    .max(30)
    .optional(),
});
export type BrandPatchIn = z.output<typeof brandPatchIn>;

async function assertNameFree(tx: Queryable, name: string, exceptId?: string): Promise<void> {
  const r = await tx.query('SELECT 1 FROM brand WHERE lower(name) = lower($1) AND id IS DISTINCT FROM $2', [
    name,
    exceptId ?? null,
  ]);
  if (r.rows[0]) throw new ApiError('conflict', 'That brand already exists');
}
async function assertCodeFree(tx: Queryable, code: string, exceptId?: string): Promise<void> {
  const r = await tx.query('SELECT 1 FROM brand WHERE code = $1 AND id IS DISTINCT FROM $2', [code, exceptId ?? null]);
  if (r.rows[0]) throw new ApiError('conflict', `Prefix ${code} is already used`);
}

export async function createBrand(
  tx: Queryable,
  user: SessionUser,
  input: z.output<typeof brandCreateIn>,
): Promise<string> {
  needBrands(user);
  // legacy addBrandS (4188): default prefix = first three letters + XXX
  const code = input.code ?? (input.name.replace(/[^A-Za-z]/g, '').toUpperCase() + 'XXX').slice(0, 3);
  await assertNameFree(tx, input.name);
  await assertCodeFree(tx, code);
  const { rows } = await tx.query(
    `INSERT INTO brand (legacy_id, code, name, color) VALUES ($1,$2,$3,$4) RETURNING id`,
    ['b' + Date.now().toString(36), code, input.name, input.color ?? '#BB5E1E'],
  );
  await appendAudit(tx, user, 'Added brand', `${input.name} (${code})`);
  return rows[0]!.id as string;
}

export async function updateBrand(tx: Queryable, user: SessionUser, id: string, input: BrandPatchIn): Promise<void> {
  needBrands(user);
  const cur = (await tx.query('SELECT id, code, name, locations FROM brand WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!cur) throw new ApiError('not_found', 'Not found');
  if (input.name !== undefined && input.name !== cur.name) await assertNameFree(tx, input.name, id);
  if (input.code !== undefined && input.code !== cur.code) await assertCodeFree(tx, input.code, id);

  const set: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, v: unknown) => {
    vals.push(v);
    set.push(`${col} = $${vals.length + 1}`);
  };
  if (input.name !== undefined) add('name', input.name);
  if (input.code !== undefined) add('code', input.code);
  if (input.color !== undefined) add('color', input.color);
  if (input.nameAr !== undefined) add('name_ar', input.nameAr || null);
  if (input.inkColor !== undefined) add('ink_color', input.inkColor);

  let siteNote = '';
  if (input.locations !== undefined) {
    const next = input.locations;
    const lower = next.map((s) => s.toLowerCase());
    if (new Set(lower).size !== next.length) throw new ApiError('bad_request', 'Site names must be unique');
    const old = cur.locations as string[];
    const renames = (input.renamedSites ?? []).filter(
      (r) => old.includes(r.from) && next.includes(r.to) && r.from !== r.to,
    );
    const renamedFrom = new Set(renames.map((r) => r.from));
    let updated = 0;
    for (const r of renames) await assertNoStock(tx, r.from, 'renamed');
    for (const r of renames) {
      updated +=
        (await tx.query('UPDATE menu_pax SET location = $2 WHERE location = $1', [r.from, r.to])).rowCount ?? 0;
      try {
        updated +=
          (
            await tx.query(
              'UPDATE production_entry SET location = $2 WHERE location = $1 AND recipe_code IN (SELECT code FROM recipe WHERE brand_id = $3)',
              [r.from, r.to, id],
            )
          ).rowCount ?? 0;
      } catch {
        throw new ApiError(
          'conflict',
          'Figures already exist under ' + r.to + ' for the same dates – merge them first',
        );
      }
    }
    const removed = old.filter((s) => !next.includes(s) && !renamedFrom.has(s));
    for (const s of removed) {
      await assertNoStock(tx, s, 'removed');
      const n =
        Number((await tx.query('SELECT count(*) AS n FROM menu_pax WHERE location = $1', [s])).rows[0]!.n) +
        Number(
          (
            await tx.query(
              'SELECT count(*) AS n FROM production_entry WHERE location = $1 AND recipe_code IN (SELECT code FROM recipe WHERE brand_id = $2)',
              [s, id],
            )
          ).rows[0]!.n,
        );
      if (n)
        throw new ApiError('conflict', `${s} has ${n} stored figure(s) – rename or merge it instead of removing it`, {
          site: s,
          rows: n,
        });
    }
    add('locations', next);
    siteNote = `${old.join(', ') || '(none)'} → ${next.join(', ') || '(none)'}; ${updated} stored row(s) updated`;
  }

  if (set.length) await tx.query(`UPDATE brand SET ${set.join(', ')} WHERE id = $1`, [id, ...vals]);
  const fields = [
    input.name !== undefined && 'name',
    input.code !== undefined && 'prefix',
    input.color !== undefined && 'colour',
    input.nameAr !== undefined && 'Arabic name',
    input.inkColor !== undefined && 'ink',
  ].filter(Boolean);
  if (fields.length)
    await appendAudit(
      tx,
      user,
      'Edited brand',
      `${input.name ?? cur.name} (${input.code ?? cur.code}): ${fields.join(', ')}`,
    );
  if (siteNote) await appendAudit(tx, user, 'Edited brand sites', `${input.name ?? cur.name}: ${siteNote}`);
}

/**
 * Stock counts and receipts are keyed by the site's name and are not carried along by a rename yet (D-76 comes with the
 * backup work in slice 2e), so a site that has any cannot be renamed or removed until then: better a refusal than rows
 * left under a name no screen offers any more.
 */
async function assertNoStock(tx: Queryable, site: string, what: 'renamed' | 'removed'): Promise<void> {
  const n =
    Number((await tx.query('SELECT count(*) AS n FROM stock_count WHERE site = $1', [site])).rows[0]!.n) +
    Number((await tx.query('SELECT count(*) AS n FROM receipt WHERE site = $1', [site])).rows[0]!.n);
  if (n)
    throw new ApiError('conflict', `Stock counts or receipts are recorded for ${site}, so it cannot be ${what} yet`, {
      site,
      rows: n,
    });
}

export async function deleteBrand(tx: Queryable, user: SessionUser, id: string): Promise<void> {
  needBrands(user);
  const cur = (await tx.query('SELECT name FROM brand WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!cur) throw new ApiError('not_found', 'Not found');
  const n = Number((await tx.query('SELECT count(*) AS n FROM recipe WHERE brand_id = $1', [id])).rows[0]!.n);
  if (n)
    throw new ApiError('conflict', `${n} card${n === 1 ? ' is' : 's are'} in ${cur.name} – move or delete them first`, {
      cards: n,
    });
  const u = Number(
    (await tx.query('SELECT count(*) AS n FROM user_brand_access WHERE brand_id = $1', [id])).rows[0]!.n,
  );
  const s = Number((await tx.query('SELECT count(*) AS n FROM item_brand_scope WHERE brand_id = $1', [id])).rows[0]!.n);
  const k = Number((await tx.query('SELECT count(*) AS n FROM client WHERE brand_id = $1', [id])).rows[0]!.n);
  if (k)
    throw new ApiError(
      'conflict',
      `${cur.name} still has ${k} client${k === 1 ? '' : 's'} - remove ${k === 1 ? 'it' : 'them'} first`,
      {
        clients: k,
      },
    );
  const inv = Number(
    (await tx.query('SELECT count(*) AS n FROM invite_brand_access WHERE brand_id = $1', [id])).rows[0]!.n,
  );
  if (u || s || inv)
    throw new ApiError(
      'conflict',
      `${cur.name} is still assigned to ${u} user(s)${inv ? `, ${inv} pending invitation(s)` : ''} and ${s} ingredient(s)`,
      { users: u, items: s, invites: inv },
    );
  await tx.query('DELETE FROM brand WHERE id = $1', [id]);
  await appendAudit(tx, user, 'Removed brand', cur.name as string);
}
