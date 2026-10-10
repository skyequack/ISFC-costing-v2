import type { Queryable } from '../client';
import { camelRow } from '../rows';

export interface SettingsDto {
  currency: string;
  pkg: number;
  del: number;
  lab: number;
  ops: number;
  buffer: number;
  target: number;
  vat: number;
  /** ISO date (YYYY-MM-DD); the pg `date` is read as text so no timezone shift can happen. */
  priceDate: string;
  version: number;
}

export async function getSettings(db: Queryable): Promise<SettingsDto> {
  const { rows } = await db.query(
    `SELECT currency, pkg, del, lab, ops, buffer, target, vat, to_char(price_date, 'YYYY-MM-DD') AS price_date, version
     FROM cost_settings WHERE id = 1`,
  );
  if (!rows[0]) throw new Error('cost_settings row is missing (database not seeded)');
  return camelRow<SettingsDto>(rows[0]);
}
