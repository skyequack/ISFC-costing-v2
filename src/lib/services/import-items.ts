import { createHash } from 'node:crypto';
import { z } from 'zod';
import { appendPriceCheck, priceMove } from '@/domain/ingredients';
import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { appendAudit } from '../db/repo/audit';
import type { BrandScope } from '../db/scope';
import { ApiError } from '../errors';
import { can } from '../permissions';
import { UNITS } from '../validation/common';
import { addPriceHistory, CODE_LOCK } from './ingredients';

/** Rows per request (D-37). The browser splits bigger files into parts. */
export const MAX_ITEM_ROWS = 500;

export const itemImportIn = z.object({
  rows: z
    .array(
      z.object({
        code: z.string().trim().min(1).max(60),
        name: z.string().trim().max(300),
        uom: z.enum(UNITS),
        price: z.number().finite().min(0).max(1e9).nullable(),
        cat: z.string().trim().max(100),
        sub: z.string().trim().max(100),
        line: z.number().int().min(0).max(1e7),
      }),
    )
    .min(1)
    .max(MAX_ITEM_ROWS),
  /** brand the items are loaded into ('' = Shared) */
  brandId: z.string().max(64).default(''),
  /** also grant the brand access to existing brand-scoped codes */
  grant: z.boolean().default(true),
  file: z.string().trim().max(200).default('price list'),
  /** commit only: the hash the dry-run returned */
  hash: z.string().max(80).optional(),
});
export type ItemImportIn = z.output<typeof itemImportIn>;

export interface ItemPlanRow {
  code: string;
  name: string;
  action: 'add' | 'update' | 'same' | 'blocked';
  old: number | null;
  price: number | null;
  hasPrice: boolean;
  /** variance as a fraction, null = new price / no old price */
  pct: number | null;
  /** D-43: beyond +-20% -> PRICE CHECK on confirm */
  check: boolean;
  reason?: string;
}

export interface ItemImportPlan {
  rows: ItemPlanRow[];
  counts: { add: number; update: number; same: number; keepPrice: number; blocked: number; priceCheck: number };
  hash: string;
  brandName: string;
}

interface Existing {
  id: string;
  code: string;
  name: string;
  uom: string;
  price: number | null;
  category: string;
  subcategory: string;
  flag: string;
  brandIds: string[];
}

function hashOf(input: Pick<ItemImportIn, 'rows' | 'brandId' | 'grant'>): string {
  return createHash('sha256').update(JSON.stringify([input.rows, input.brandId, input.grant])).digest('hex');
}

async function loadExisting(tx: Queryable, codes: string[]): Promise<Map<string, Existing>> {
  const { rows } = await tx.query(
    `SELECT i.id, i.code, i.name, i.uom, i.price, i.category, i.subcategory, i.flag,
            coalesce((SELECT array_agg(s.brand_id) FROM item_brand_scope s WHERE s.ingredient_id = i.id), '{}') AS brand_ids
       FROM ingredient i WHERE i.code = ANY($1::text[]) FOR UPDATE OF i`,
    [codes],
  );
  return new Map(
    rows.map((r) => [
      r.code as string,
      { id: r.id, code: r.code, name: r.name, uom: r.uom, price: r.price, category: r.category, subcategory: r.subcategory, flag: r.flag, brandIds: r.brand_ids as string[] },
    ]),
  );
}

async function resolveBrand(tx: Queryable, user: SessionUser, scope: BrandScope, brandId: string): Promise<{ id: string; name: string } | null> {
  if (!brandId) return null;
  if (user.role !== 'gm' && !scope.brandIds.includes(brandId)) throw new ApiError('forbidden', 'You have no access to that brand');
  const b = (await tx.query('SELECT id, name FROM brand WHERE id = $1', [brandId])).rows[0];
  if (!b) throw new ApiError('bad_request', 'Unknown brand');
  return { id: b.id as string, name: b.name as string };
}

/** Build the plan (also used by commit, inside its transaction, so what is written is what was reviewed). */
async function plan(tx: Queryable, user: SessionUser, scope: BrandScope, input: ItemImportIn): Promise<ItemImportPlan & { existing: Map<string, Existing>; bid: string }> {
  if (!can(user.role, 'items.edit')) throw new ApiError('forbidden', 'Your role cannot do that');
  const seen = new Set<string>();
  for (const r of input.rows) {
    if (seen.has(r.code)) throw new ApiError('bad_request', `The code ${r.code} appears twice in this part of the file`);
    seen.add(r.code);
  }
  const brand = await resolveBrand(tx, user, scope, input.brandId);
  const existing = await loadExisting(tx, input.rows.map((r) => r.code));
  // cross-namespace: a new ingredient code must not collide with a recipe code (case-insensitive)
  const clashes = await tx.query(
    `SELECT code FROM recipe WHERE deleted_at IS NULL AND upper(code) = ANY($1::text[])`,
    [input.rows.filter((r) => !existing.has(r.code)).map((r) => r.code.toUpperCase())],
  );
  const recipeCodes = new Set(clashes.rows.map((r) => String(r.code).toUpperCase()));
  const lowerExisting = await tx.query(`SELECT code FROM ingredient WHERE upper(code) = ANY($1::text[])`, [
    input.rows.filter((r) => !existing.has(r.code)).map((r) => r.code.toUpperCase()),
  ]);
  const caseClash = new Set(lowerExisting.rows.map((r) => String(r.code).toUpperCase()));

  const rows: ItemPlanRow[] = [];
  const counts = { add: 0, update: 0, same: 0, keepPrice: 0, blocked: 0, priceCheck: 0 };
  for (const p of input.rows) {
    const ex = existing.get(p.code);
    const hasPrice = p.price !== null;
    if (!ex) {
      if (recipeCodes.has(p.code.toUpperCase()) || caseClash.has(p.code.toUpperCase())) {
        rows.push({ code: p.code, name: p.name, action: 'blocked', old: null, price: p.price, hasPrice, pct: null, check: false, reason: 'the code already exists in another spelling or as a recipe card' });
        counts.blocked++;
        continue;
      }
      rows.push({ code: p.code, name: p.name, action: 'add', old: null, price: p.price, hasPrice, pct: null, check: false });
      counts.add++;
      continue;
    }
    // an existing brand-scoped item the caller cannot see is off limits
    if (ex.brandIds.length && !ex.brandIds.some((b) => scope.brandIds.includes(b))) {
      rows.push({ code: p.code, name: p.name, action: 'blocked', old: ex.price, price: p.price, hasPrice, pct: null, check: false, reason: 'not available to your brands' });
      counts.blocked++;
      continue;
    }
    if (!hasPrice) counts.keepPrice++;
    const moved = hasPrice && (ex.price == null || Math.abs(ex.price - (p.price as number)) > 1e-9);
    const other = (p.name && p.name !== ex.name) || p.uom !== ex.uom || (p.cat && p.cat !== ex.category) || (p.sub && p.sub !== ex.subcategory);
    if (!moved && !other) {
      rows.push({ code: p.code, name: ex.name, action: 'same', old: ex.price, price: p.price, hasPrice, pct: null, check: false });
      counts.same++;
      continue;
    }
    const mv = moved ? priceMove(ex.price, p.price) : { pct: null, check: false };
    rows.push({ code: p.code, name: p.name || ex.name, action: 'update', old: ex.price, price: p.price, hasPrice, pct: mv.pct, check: mv.check });
    counts.update++;
    if (mv.check) counts.priceCheck++;
  }
  return { rows, counts, hash: hashOf(input), brandName: brand?.name ?? 'Shared', existing, bid: brand?.id ?? '' };
}

export async function previewItemImport(tx: Queryable, user: SessionUser, scope: BrandScope, input: ItemImportIn): Promise<ItemImportPlan> {
  const p = await plan(tx, user, scope, input);
  return { rows: p.rows, counts: p.counts, hash: p.hash, brandName: p.brandName };
}

/** Writes one part of a price list. Every price change appends history (source IMPORT); PRICE CHECK flags only on confirm (D-43). */
export async function commitItemImport(tx: Queryable, user: SessionUser, scope: BrandScope, input: ItemImportIn): Promise<{ added: number; updated: number; granted: number; flagged: number }> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [CODE_LOCK]);
  const p = await plan(tx, user, scope, input);
  if (!input.hash || input.hash !== p.hash) throw new ApiError('conflict', 'The file changed since it was checked - check it again');
  if (p.counts.blocked) throw new ApiError('unprocessable', `${p.counts.blocked} row(s) cannot be loaded - fix them and check again`, { blocked: p.rows.filter((r) => r.action === 'blocked').slice(0, 20) });
  const byCode = new Map(input.rows.map((r) => [r.code, r]));
  let added = 0,
    updated = 0,
    granted = 0,
    flagged = 0;
  for (const row of p.rows) {
    const src = byCode.get(row.code)!;
    const ex = p.existing.get(row.code);
    if (row.action === 'add') {
      const ins = await tx.query(
        `INSERT INTO ingredient (code, name, uom, price, price_updated_at, category, subcategory)
         VALUES ($1,$2,$3,$4, CASE WHEN $4::float8 IS NULL THEN NULL ELSE now() END, $5, $6) RETURNING id`,
        [src.code, src.name || src.code, src.uom, src.price, src.cat || 'Uncategorised', src.sub || 'Uncategorised'],
      );
      const id = ins.rows[0]!.id as string;
      if (p.bid) await tx.query('INSERT INTO item_brand_scope (ingredient_id, brand_id) VALUES ($1,$2)', [id, p.bid]);
      if (src.price !== null) await addPriceHistory(tx, user, id, null, src.price, 'IMPORT');
      added++;
      continue;
    }
    if (!ex) continue;
    if (row.action === 'update') {
      const moved = row.hasPrice && (ex.price == null || Math.abs(ex.price - (src.price as number)) > 1e-9);
      const flag = row.check ? appendPriceCheck(ex.flag) : ex.flag;
      if (flag !== ex.flag) flagged++;
      await tx.query(
        `UPDATE ingredient SET name = coalesce(nullif($2,''), name), uom = $3,
                price = CASE WHEN $4 THEN $5::float8 ELSE price END,
                price_updated_at = CASE WHEN $4 THEN now() ELSE price_updated_at END,
                category = coalesce(nullif($6,''), category), subcategory = coalesce(nullif($7,''), subcategory),
                flag = $8, version = version + 1 WHERE id = $1`,
        [ex.id, src.name, src.uom, moved, src.price, src.cat, src.sub, flag],
      );
      if (moved) await addPriceHistory(tx, user, ex.id, ex.price, src.price, 'IMPORT');
      updated++;
    }
    if (p.bid && input.grant && ex.brandIds.length && !ex.brandIds.includes(p.bid)) {
      await tx.query('INSERT INTO item_brand_scope (ingredient_id, brand_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ex.id, p.bid]);
      granted++;
    }
  }
  await appendAudit(
    tx,
    user,
    'Uploaded price list',
    `${input.file} – ${p.brandName}: ${added} added, ${updated} updated${granted ? `, ${granted} shared with the brand` : ''}${flagged ? `, ${flagged} flagged PRICE CHECK` : ''}`,
  );
  return { added, updated, granted, flagged };
}
