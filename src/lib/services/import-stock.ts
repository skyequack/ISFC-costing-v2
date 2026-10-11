import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SessionUser } from '../auth/types';
import { pgErrorCode, type Queryable } from '../db/client';
import { appendAudit } from '../db/repo/audit';
import { ingredientCodesInScope } from '../db/repo/ingredients';
import { visibleSites } from '../db/repo/stock';
import type { BrandScope } from '../db/scope';
import { ApiError } from '../errors';
import { can } from '../permissions';
import { MAX_STOCK_QTY } from '../stock-limits';
import { siteStr } from './planning';
import { latestStockDate, STOCK_KINDS, stockDate } from './stock';

/** Rows per upload (D-73). One request, one transaction: the file is loaded whole or not at all. */
export const MAX_STOCK_IMPORT_ROWS = 5000;

export const stockImportIn = z.object({
  kind: z.enum(STOCK_KINDS),
  rows: z
    .array(
      z.object({
        site: siteStr.refine((v) => v !== '', 'a site is required'),
        date: stockDate,
        code: z.string().trim().min(1).max(60),
        qty: z.number().finite().min(0).max(MAX_STOCK_QTY),
        line: z.number().int().min(0).max(1e7),
      }),
    )
    .min(1)
    .max(MAX_STOCK_IMPORT_ROWS),
  file: z.string().trim().max(200).default('stock file'),
  /** commit only: the hash the dry-run returned */
  hash: z.string().max(80).optional(),
});
export type StockImportIn = z.output<typeof stockImportIn>;

export interface StockPlanRow {
  line: number;
  site: string;
  date: string;
  code: string;
  name: string;
  qty: number;
  /** the stored count it replaces (counts only) */
  old: number | null;
  action: 'add' | 'update' | 'same' | 'blocked';
  reason?: string;
}

export interface StockImportPlan {
  kind: StockImportIn['kind'];
  total: number;
  counts: { add: number; update: number; same: number; blocked: number };
  /** the first few rows that cannot be loaded, with the reason */
  blocked: StockPlanRow[];
  /** the first changes (adds and updates), with names, for the review table */
  sample: StockPlanRow[];
  sites: string[];
  dates: string[];
  hash: string;
  /** receipts only: this very file was already loaded (same content) */
  alreadyImported: boolean;
}

const SHOWN = 50;

/** What is in the file, not its name or row numbers: the same sheet under another name is the same upload. */
function hashOf(input: StockImportIn): string {
  return createHash('sha256')
    .update(JSON.stringify([input.kind, input.rows.map((r) => [r.site, r.date, r.code, r.qty])]))
    .digest('hex');
}
/** Receipts loaded from a file carry this as their `ref`, so an upload never touches the rows typed in the grid. */
export const receiptRef = (hash: string): string => `file:${hash.slice(0, 16)}`;

async function plan(tx: Queryable, user: SessionUser, scope: BrandScope, input: StockImportIn) {
  if (!can(user.role, 'stock.edit')) throw new ApiError('forbidden', 'Your role cannot do that');
  const isCount = input.kind === 'count';
  const latest = latestStockDate();
  const sites = new Set(await visibleSites(tx, scope));
  const inScope = await ingredientCodesInScope(tx, scope, [...new Set(input.rows.map((r) => r.code))]);
  const hash = hashOf(input);

  // what is stored now, for the counts being replaced
  const old = new Map<string, number>();
  if (isCount) {
    const { rows } = await tx.query(
      `SELECT s.site, s.count_date::text AS d, s.code, s.qty
         FROM stock_count s
         JOIN unnest($1::text[], $2::date[], $3::text[]) AS t(site, d, code)
           ON s.site = t.site AND s.count_date = t.d AND s.code = t.code`,
      [input.rows.map((r) => r.site), input.rows.map((r) => r.date), input.rows.map((r) => r.code)],
    );
    for (const r of rows) old.set(`${r.site}|${r.d}|${r.code}`, r.qty as number);
  }

  const seen = new Set<string>();
  const planned: StockPlanRow[] = input.rows.map((r) => {
    const key = `${r.site}|${r.date}|${r.code}`;
    const base = {
      line: r.line,
      site: r.site,
      date: r.date,
      code: r.code,
      name: '',
      qty: r.qty,
      old: old.get(key) ?? null,
    };
    const block = (reason: string): StockPlanRow => ({ ...base, action: 'blocked', reason });
    if (!sites.has(r.site)) return block('not one of your sites');
    if (r.date > latest) return block('the date is in the future');
    if (!inScope.has(r.code)) return block('not an ingredient you can use');
    if (!isCount && r.qty === 0) return block('a delivery must be more than 0');
    if (seen.has(key)) return block('appears twice in the file for the same site and date');
    seen.add(key);
    if (!isCount) return { ...base, action: 'add' };
    return { ...base, action: base.old === null ? 'add' : Math.abs(base.old - r.qty) > 1e-12 ? 'update' : 'same' };
  });

  const counts = { add: 0, update: 0, same: 0, blocked: 0 };
  for (const p of planned) counts[p.action]++;
  const blocked = planned.filter((p) => p.action === 'blocked').slice(0, SHOWN);
  const sample = planned.filter((p) => p.action === 'add' || p.action === 'update').slice(0, SHOWN);
  // names only for ingredients the caller may use: a blocked row for another brand's ingredient must not reveal its name
  const known = [...new Set([...blocked, ...sample].map((p) => p.code))].filter((c) => inScope.has(c));
  const names = known.length
    ? await tx.query('SELECT code, name FROM ingredient WHERE code = ANY($1::text[])', [known])
    : { rows: [] as { code: string; name: string }[] };
  const nameOf = new Map(names.rows.map((r) => [r.code as string, r.name as string]));
  for (const p of [...blocked, ...sample]) p.name = nameOf.get(p.code) ?? '';

  const already = isCount
    ? false
    : ((await tx.query('SELECT 1 FROM receipt WHERE ref = $1 LIMIT 1', [receiptRef(hash)])).rowCount ?? 0) > 0;
  const out: StockImportPlan = {
    kind: input.kind,
    total: planned.length,
    counts,
    blocked,
    sample,
    sites: [...new Set(input.rows.map((r) => r.site))].sort(),
    dates: [...new Set(input.rows.map((r) => r.date))].sort(),
    hash,
    alreadyImported: already,
  };
  return { out, planned };
}

/** Check a stock file without writing anything (D-73). */
export async function previewStockImport(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  input: StockImportIn,
): Promise<StockImportPlan> {
  return (await plan(tx, user, scope, input)).out;
}

/**
 * Load a stock file whole or not at all: the file must be the one that was checked (hash), no row may be blocked, and a
 * receipts file already loaded is refused (409) so a double click never doubles the deliveries. Counts are upserted by
 * site, day and code (only rows that change); receipts are added under the file's ref. One audit row, never the values.
 */
export async function commitStockImport(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  input: StockImportIn,
): Promise<{ added: number; updated: number; same: number }> {
  // one commit of a given content at a time, so a double click cannot slip past the 'already loaded' check
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['stock-import:' + hashOf(input)]);
  const { out, planned } = await plan(tx, user, scope, input);
  if (!input.hash || input.hash !== out.hash)
    throw new ApiError('conflict', 'The file changed since it was checked - check it again');
  if (out.counts.blocked)
    throw new ApiError('unprocessable', `${out.counts.blocked} row(s) cannot be loaded - fix them and check again`, {
      blocked: out.blocked.slice(0, 20),
    });
  if (out.alreadyImported) throw new ApiError('conflict', 'This file has already been loaded');

  const write = planned.filter((p) => p.action === 'add' || p.action === 'update');
  const args = [
    write.map((p) => p.site),
    write.map((p) => p.date),
    write.map((p) => p.code),
    write.map((p) => p.qty),
    user.name,
  ];
  if (write.length) {
    if (input.kind === 'count')
      await tx.query(
        `INSERT INTO stock_count (site, count_date, code, qty, updated_by)
         SELECT t.site, t.d, t.code, t.q, $5 FROM unnest($1::text[], $2::date[], $3::text[], $4::float8[]) AS t(site, d, code, q)
         ON CONFLICT (site, count_date, code) DO UPDATE SET qty = EXCLUDED.qty, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        args,
      );
    else
      try {
        await tx.query(
          `INSERT INTO receipt (site, receipt_date, code, qty, ref, updated_by)
           SELECT t.site, t.d, t.code, t.q, $6, $5 FROM unnest($1::text[], $2::date[], $3::text[], $4::float8[]) AS t(site, d, code, q)`,
          [...args, receiptRef(out.hash)],
        );
      } catch (e) {
        if (pgErrorCode(e) === '23505') throw new ApiError('conflict', 'This file has already been loaded');
        throw e;
      }
  }
  const res = { added: out.counts.add, updated: out.counts.update, same: out.counts.same };
  await appendAudit(
    tx,
    user,
    input.kind === 'count' ? 'Uploaded stock counts' : 'Uploaded receipts',
    `${input.file} (${out.hash.slice(0, 12)}): ${res.added} added${input.kind === 'count' ? `, ${res.updated} updated, ${res.same} unchanged` : ''} · ${out.sites.join(', ')} · ${out.dates[0]}${out.dates.length > 1 ? ` to ${out.dates.at(-1)}` : ''}`,
  );
  return res;
}

export const stockUndoIn = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/, 'not an upload hash') });

/**
 * Take back a receipts upload (D-73): deletes the deliveries that carry the file's ref, at the sites the caller can see (so
 * someone who happens to know a hash cannot touch other sites). Deliveries typed in the grid are never touched. Counts need no
 * undo: they are upserts and the grid corrects them. 404 when nothing is left to undo. One audit row, no values.
 */
export async function undoReceiptUpload(
  tx: Queryable,
  user: SessionUser,
  scope: BrandScope,
  input: z.output<typeof stockUndoIn>,
): Promise<{ removed: number }> {
  if (!can(user.role, 'stock.edit')) throw new ApiError('forbidden', 'Your role cannot do that');
  const sites = await visibleSites(tx, scope);
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['stock-import:' + input.hash]);
  const r = await tx.query('DELETE FROM receipt WHERE ref = $1 AND site = ANY($2::text[])', [
    receiptRef(input.hash),
    sites,
  ]);
  const removed = r.rowCount ?? 0;
  if (!removed) throw new ApiError('not_found', 'Nothing left to undo');
  await appendAudit(tx, user, 'Undid a receipts upload', `${input.hash.slice(0, 12)}: ${removed} deliveries removed`);
  return { removed };
}
