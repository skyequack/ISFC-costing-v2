import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { appendAudit } from '../db/repo/audit';
import { ApiError } from '../errors';
import { can } from '../permissions';
import type { UnitKind } from '../units';

/** The cap on the whole unit list, so a runaway client cannot fill it. */
export const MAX_UNITS = 60;
/** A unit code: letters, digits, space and . / % - (the same characters the Items form can show safely). */
export const UNIT_CODE = /^[A-Za-z0-9][A-Za-z0-9 ./%-]{0,15}$/;

export interface UnitRow {
  code: string;
  kind: UnitKind;
  /** base units in one of this unit; null = a pack unit, the factor is entered per item */
  toBase: number | null;
  /** items using it as purchase or inventory unit (0 = it can be deleted) */
  used: number;
}

export async function listUnits(db: Queryable): Promise<UnitRow[]> {
  const { rows } = await db.query(
    `SELECT u.code, u.kind, u.to_base,
            (SELECT count(*)::int FROM ingredient i WHERE i.purchase_unit = u.code OR i.inventory_unit = u.code) AS used
       FROM unit u ORDER BY u.sort, u.code`,
  );
  return rows.map((r) => ({ code: r.code, kind: r.kind, toBase: r.to_base, used: r.used }));
}

function needUnits(user: SessionUser): void {
  if (!can(user.role, 'units.edit')) throw new ApiError('forbidden', 'Your role cannot do that');
}

/** D-103: the GM adds a pack unit (its factor is entered per item). The seeded fixed units cannot be added or changed. */
export async function addUnit(tx: Queryable, user: SessionUser, code: string): Promise<void> {
  needUnits(user);
  if (!UNIT_CODE.test(code))
    throw new ApiError('bad_request', 'A unit name is letters and numbers, up to 16 characters');
  await tx.query('SELECT pg_advisory_xact_lock(8041002)');
  const n = (await tx.query('SELECT count(*)::int AS n FROM unit')).rows[0]!.n as number;
  if (n >= MAX_UNITS) throw new ApiError('unprocessable', `The unit list is full (${MAX_UNITS})`);
  const clash = await tx.query('SELECT code FROM unit WHERE lower(code) = lower($1)', [code]);
  if (clash.rows[0]) throw new ApiError('conflict', `${clash.rows[0].code} is already in the list`);
  await tx.query(`INSERT INTO unit (code, kind, to_base, sort) VALUES ($1, 'pack', NULL, 200)`, [code]);
  await appendAudit(tx, user, 'Added unit', code);
}

/** Only an added pack unit that no item uses can go; Gram, Kg, Ml, L, Each and Slice are fixed. */
export async function deleteUnit(tx: Queryable, user: SessionUser, code: string): Promise<void> {
  needUnits(user);
  const { rows } = await tx.query('SELECT code, kind FROM unit WHERE code = $1 FOR UPDATE', [code]);
  const u = rows[0];
  if (!u) throw new ApiError('not_found', 'Not found');
  if (u.kind !== 'pack') throw new ApiError('unprocessable', `${u.code} is a base unit and cannot be deleted`);
  const used = (
    await tx.query('SELECT count(*)::int AS n FROM ingredient WHERE purchase_unit = $1 OR inventory_unit = $1', [
      u.code,
    ])
  ).rows[0]!.n as number;
  if (used)
    throw new ApiError('conflict', `${u.code} is used by ${used} item(s) – change those first`, { items: used });
  await tx.query('DELETE FROM unit WHERE code = $1', [u.code]);
  await appendAudit(tx, user, 'Deleted unit', u.code);
}
