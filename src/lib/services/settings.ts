import { z } from 'zod';
import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { appendAudit } from '../db/repo/audit';
import { getSettings } from '../db/repo/settings';
import { ApiError } from '../errors';
import { can } from '../permissions';

const frac = (max: number) => z.number().finite().min(0).max(max);

/** Fractions as stored (D-04). Loads and buffer are bounded so a typo (150 instead of 15) is rejected, not saved. */
export const settingsIn = z.object({
  version: z.number().int().min(0),
  currency: z.string().trim().min(1).max(8).optional(),
  priceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  pkg: frac(0.95).optional(),
  del: frac(0.95).optional(),
  lab: frac(0.95).optional(),
  ops: frac(0.95).optional(),
  buffer: frac(5).optional(),
  target: z.number().finite().gt(0).max(1).optional(),
  vat: frac(1).optional(),
});
export type SettingsIn = z.output<typeof settingsIn>;

const KEYS = ['currency', 'priceDate', 'pkg', 'del', 'lab', 'ops', 'buffer', 'target', 'vat'] as const;
const COL: Record<string, string> = { priceDate: 'price_date' };
const PCT = new Set(['pkg', 'del', 'lab', 'ops', 'buffer', 'target', 'vat']);

export async function updateSettings(
  tx: Queryable,
  user: SessionUser,
  input: SettingsIn,
): Promise<{ changed: string[]; cards: number }> {
  if (!can(user.role, 'settings.edit'))
    throw new ApiError('forbidden', 'Only a General Manager or Finance can change the cost settings');
  const cur = await tx.query('SELECT version FROM cost_settings WHERE id = 1 FOR UPDATE');
  if (!cur.rows[0]) throw new Error('cost_settings row is missing');
  if (cur.rows[0].version !== input.version)
    throw new ApiError('conflict', 'The settings were changed by someone else – reload');
  const old = await getSettings(tx);
  const changed = KEYS.filter((k) => input[k] !== undefined && input[k] !== old[k]);
  if (!changed.length) return { changed: [], cards: 0 };
  await tx.query(
    `UPDATE cost_settings SET ${changed.map((k, i) => `${COL[k] ?? k} = $${i + 1}`).join(', ')}, version = version + 1 WHERE id = 1`,
    changed.map((k) => input[k]),
  );
  const cards = Number((await tx.query(`SELECT count(*) AS n FROM recipe WHERE deleted_at IS NULL`)).rows[0]!.n);
  const text = changed
    .map((k) =>
      PCT.has(k)
        ? `${k} ${(Number(old[k]) * 100).toFixed(2)}% → ${(Number(input[k]) * 100).toFixed(2)}%`
        : `${k} ${old[k]} → ${input[k]}`,
    )
    .join('; ');
  await appendAudit(tx, user, 'Settings changed', `${text} (${cards} cards affected)`);
  return { changed: changed as string[], cards };
}
