import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { assertAcyclic } from '@/domain/recipes/graph';
import { stagedYield, validYield } from '@/domain/recipes/yield-stages';
import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { appendAudit } from '../db/repo/audit';
import { ApiError } from '../errors';
import { can } from '../permissions';
import { pgImageStore, validateImage } from '../images';
import { IMAGE_CHUNK_BYTES } from '../io-limits';
import { MAX_STOCK_QTY } from '../stock-limits';
import { STOCK_CLASSES, UNITS } from '../units';
import { CODE_LOCK } from './ingredients';

/**
 * Full JSON backup (docs/legacy/05 §6, D-37, D-49). The backup carries data in a stable v1 shape keyed by CODES (never database ids),
 * images as base64 in separate parts so no single HTTP response exceeds the platform limit. Users and the audit log are
 * not part of it (accounts live in Clerk; the log is append-only). Needs data.admin.
 */
export const BACKUP_FORMAT = 'isfc-backup';

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'not a calendar date');

const brandB = z.object({
  legacyId: z.string().max(80),
  code: z.string().min(1).max(8),
  name: z.string().min(1).max(120),
  nameAr: z.string().max(120).nullable(),
  color: z.string().max(20),
  inkColor: z.string().max(20).nullable(),
  locations: z.array(z.string().max(60)).max(60),
  active: z.boolean(),
});
const stageB = z.number().finite().gt(0).max(10).nullable().optional();
const ingB = z.object({
  code: z.string().min(1).max(60),
  name: z.string().max(300),
  uom: z.enum(UNITS),
  price: z.number().finite().min(0).nullable(),
  priceUpdatedAt: z.string().nullable(),
  category: z.string().max(100),
  subcategory: z.string().max(100),
  flag: z.string().max(500),
  brandCodes: z.array(z.string().max(8)).max(60),
  conv: z.object({ recipeUnit: z.string().max(12), factor: z.number().finite().gt(0) }).nullable(),
  /** default yield stages (D-93): optional, so files from before restore with none (the restore clears them) */
  yThaw: stageB,
  yCut: stageB,
  yCook: stageB,
});
const lineB = z
  .object({
    code: z.string().max(60),
    qty: z.number().finite().min(0),
    unit: z.string().max(12),
    y: z.number().finite().gt(0),
    yp: z.number().finite().nullable(),
    /** three-stage yield (D-70, D-85): optional, so files from before restore with no stages */
    yThaw: stageB,
    yCut: stageB,
    yCook: stageB,
  })
  .refine((l) => {
    const p = stagedYield(l);
    return p === null || validYield(p);
  }, 'The three stages together must give a yield above 0 and up to 1000%');
const recB = z.object({
  code: z.string().min(1).max(60),
  name: z.string().max(200),
  category: z.string().max(100),
  /** D-97, optional so older backups still restore (absent = not set). */
  stockClass: z.enum(STOCK_CLASSES).nullable().optional(),
  type: z.enum(['MENU', 'SUB']),
  brandCode: z.string().max(8),
  output: z.number().finite().gt(0),
  subQty: z.number().finite().min(0),
  subUom: z.string().max(12),
  batchOut: z.number().finite().min(0),
  batchUom: z.string().max(12),
  sellingPrice: z.number().finite().min(0),
  buffer: z.number().finite().nullable(),
  status: z.enum(['DRAFT', 'LOCKED']),
  lockedBy: z.string().max(200).nullable(),
  lockedAt: z.string().nullable(),
  costAtLock: z.unknown().nullable(),
  lines: z.array(lineB).max(1000),
  method: z.array(z.string().max(2000)).max(300),
  history: z.array(z.object({ action: z.enum(['LOCK', 'UNLOCK']), who: z.string().max(200), at: z.string() })).max(500),
});
const cellB = z.object({
  kind: z.enum(['ITEM', 'RECIPE', 'NONE']),
  code: z.string().nullable(),
  label: z.string().max(300),
});
const menuB = z.object({
  name: z.string().min(1).max(120),
  legacyIndex: z.number().int().nullable(),
  sortOrder: z.number().int(),
  days: z.array(z.string().max(20)).max(7),
  active: z.boolean(),
  rows: z.array(z.object({ meal: z.string().max(60), cells: z.record(z.string(), cellB) })).max(200),
});

export const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(1),
  exportedAt: z.string(),
  settings: z.object({
    currency: z.string().max(8),
    pkg: z.number().finite().min(0).max(5),
    del: z.number().finite().min(0).max(5),
    lab: z.number().finite().min(0).max(5),
    ops: z.number().finite().min(0).max(5),
    buffer: z.number().finite().min(0).max(5),
    target: z.number().finite().gt(0).max(1),
    vat: z.number().finite().min(0).max(1),
    priceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  brands: z.array(brandB).max(500),
  ingredients: z.array(ingB).max(60000),
  recipes: z.array(recB).max(20000),
  menus: z.array(menuB).max(200),
  menuPax: z
    .array(
      z.object({
        month: z.string(),
        day: z.string(),
        location: z.string(),
        menu: z.string(),
        people: z.number().int().min(0),
      }),
    )
    .max(300000),
  production: z
    .array(
      z.object({
        month: z.string(),
        day: z.string(),
        location: z.string(),
        recipeCode: z.string(),
        /** the backup's client id; '' = unassigned. Files from before clients existed have none (D-71, D-75). */
        clientId: z.string().max(64).default(''),
        portions: z.number().int().min(0),
      }),
    )
    .max(600000),
  /** optional: files from before clients existed restore unchanged (D-75) */
  clients: z
    .array(z.object({ id: z.string().max(64), brandCode: z.string(), name: z.string().max(80), active: z.boolean() }))
    .max(5000)
    .optional(),
  /**
   * Stock (D-75, D-83): optional, so files from before stock restore unchanged. `stockFrom` is the first day of the window
   * the file covers (the last 13 months when it was made); a restore replaces the rows from that day on and leaves older ones.
   */
  stockFrom: isoDay.optional(),
  stockCounts: z
    .array(
      z.object({
        site: z.string().min(1).max(60),
        date: isoDay,
        code: z.string().min(1).max(60),
        qty: z.number().finite().min(0).max(MAX_STOCK_QTY),
      }),
    )
    .max(600000)
    .optional(),
  receipts: z
    .array(
      z.object({
        site: z.string().min(1).max(60),
        date: isoDay,
        code: z.string().min(1).max(60),
        qty: z.number().finite().gt(0).max(MAX_STOCK_QTY),
        ref: z.string().max(100),
      }),
    )
    .max(600000)
    .optional(),
  /** present only when the images were exported too */
  photos: z.array(z.object({ recipeCode: z.string(), data: z.string() })).optional(),
  logos: z.array(z.object({ brandCode: z.string(), data: z.string() })).optional(),
});
export type Backup = z.output<typeof backupSchema>;

function needAdmin(user: SessionUser): void {
  if (!can(user.role, 'data.admin')) throw new ApiError('forbidden', 'Only the General Manager can do that');
}

/** The data part of a backup (no image bytes). */
export async function buildBackupCore(db: Queryable, user: SessionUser): Promise<Omit<Backup, 'photos' | 'logos'>> {
  needAdmin(user);
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
  const set = (
    await db.query(
      `SELECT currency, pkg, del, lab, ops, buffer, target, vat, to_char(price_date, 'YYYY-MM-DD') AS price_date FROM cost_settings WHERE id = 1`,
    )
  ).rows[0]!;
  const brands = (
    await db.query(
      "SELECT id, legacy_id, code, name, name_ar, color, ink_color, locations, active FROM brand ORDER BY legacy_id <> 'bnc', name",
    )
  ).rows;
  const codeOf = new Map(brands.map((b) => [b.id as string, b.code as string]));
  const ing = (
    await db.query(
      `SELECT i.id, i.code, i.name, i.uom, i.price, i.price_updated_at, i.category, i.subcategory, i.flag, i.y_thaw, i.y_cut, i.y_cook, c.recipe_unit, c.factor,
            coalesce((SELECT array_agg(s.brand_id) FROM item_brand_scope s WHERE s.ingredient_id = i.id), '{}') AS brand_ids
       FROM ingredient i LEFT JOIN unit_conversion c ON c.ingredient_id = i.id ORDER BY i.code`,
    )
  ).rows;
  const recs = (
    await db.query(
      `SELECT id, code, name, category, stock_class, type, brand_id, output, sub_qty, sub_uom, batch_out, batch_uom, selling_price, buffer, status, locked_by, locked_at, cost_at_lock
       FROM recipe WHERE deleted_at IS NULL ORDER BY code`,
    )
  ).rows;
  const lines = (
    await db.query(
      `SELECT l.recipe_id, l.code, l.qty, l.unit, l.y, l.yp, l.y_thaw, l.y_cut, l.y_cook FROM recipe_line l JOIN recipe r ON r.id = l.recipe_id AND r.deleted_at IS NULL ORDER BY l.recipe_id, l.sort_order`,
    )
  ).rows;
  const steps = (
    await db.query(
      `SELECT s.recipe_id, s.text FROM recipe_method_step s JOIN recipe r ON r.id = s.recipe_id AND r.deleted_at IS NULL ORDER BY s.recipe_id, s.step_number`,
    )
  ).rows;
  const hist = (
    await db.query(
      `SELECT h.recipe_id, h.action, h.who, h.created_at FROM recipe_history_entry h JOIN recipe r ON r.id = h.recipe_id AND r.deleted_at IS NULL ORDER BY h.recipe_id, h.created_at`,
    )
  ).rows;
  type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const group = (rows: Row[]) => {
    const m = new Map<string, Row[]>();
    for (const r of rows)
      (m.get(r.recipe_id as string) ?? m.set(r.recipe_id as string, []).get(r.recipe_id as string)!).push(r);
    return m;
  };
  const L = group(lines);
  const S = group(steps);
  const H = group(hist);
  const menus = (
    await db.query('SELECT id, name, legacy_index, sort_order, days, active FROM menu ORDER BY sort_order, id')
  ).rows;
  const mrows = (
    await db.query(
      `SELECT r.menu_id, r.id AS rid, r.meal, c.day, c.kind, c.code, c.label FROM menu_row r LEFT JOIN menu_cell c ON c.row_id = r.id ORDER BY r.menu_id, r.sort_order, c.day`,
    )
  ).rows;
  const menuName = new Map(menus.map((m) => [m.id as string, m.name as string]));
  const pax = (
    await db.query('SELECT month, day, location, menu_id, people FROM menu_pax ORDER BY month, day, location, menu_id')
  ).rows;
  const prod = (
    await db.query(
      'SELECT month, day, location, client_id, recipe_code, portions FROM production_entry ORDER BY month, day, location, client_id, recipe_code',
    )
  ).rows;

  const stockFrom = (
    await db.query(`SELECT to_char((current_date - interval '${STOCK_MONTHS} months')::date, 'YYYY-MM-DD') AS d`)
  ).rows[0]!.d as string;
  const clientRows = (
    await db.query(
      'SELECT c.id, b.code AS brand_code, c.name, c.active FROM client c JOIN brand b ON b.id = c.brand_id ORDER BY b.code, lower(c.name)',
    )
  ).rows;

  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: {
      currency: set.currency,
      pkg: set.pkg,
      del: set.del,
      lab: set.lab,
      ops: set.ops,
      buffer: set.buffer,
      target: set.target,
      vat: set.vat,
      priceDate: set.price_date,
    },
    brands: brands.map((b) => ({
      legacyId: b.legacy_id,
      code: b.code,
      name: b.name,
      nameAr: b.name_ar,
      color: b.color,
      inkColor: b.ink_color,
      locations: b.locations,
      active: b.active,
    })),
    ingredients: ing.map((i) => ({
      code: i.code,
      name: i.name,
      uom: i.uom,
      price: i.price,
      priceUpdatedAt: iso(i.price_updated_at),
      category: i.category,
      subcategory: i.subcategory,
      flag: i.flag,
      brandCodes: (i.brand_ids as string[]).map((id) => codeOf.get(id) ?? '').filter(Boolean),
      conv: i.recipe_unit ? { recipeUnit: i.recipe_unit, factor: i.factor } : null,
      yThaw: i.y_thaw ?? null,
      yCut: i.y_cut ?? null,
      yCook: i.y_cook ?? null,
    })),
    recipes: recs.map((r) => ({
      code: r.code,
      name: r.name,
      category: r.category,
      stockClass: r.stock_class ?? null,
      type: r.type,
      brandCode: codeOf.get(r.brand_id) ?? '',
      output: r.output,
      subQty: r.sub_qty,
      subUom: r.sub_uom,
      batchOut: r.batch_out,
      batchUom: r.batch_uom,
      sellingPrice: r.selling_price,
      buffer: r.buffer,
      status: r.status,
      lockedBy: r.locked_by,
      lockedAt: iso(r.locked_at),
      costAtLock: r.cost_at_lock,
      lines: (L.get(r.id) ?? []).map((l) => ({
        code: l.code,
        qty: l.qty,
        unit: l.unit,
        y: l.y,
        yp: l.yp,
        yThaw: l.y_thaw ?? null,
        yCut: l.y_cut ?? null,
        yCook: l.y_cook ?? null,
      })),
      method: (S.get(r.id) ?? []).map((x) => x.text),
      history: (H.get(r.id) ?? []).map((h) => ({ action: h.action, who: h.who, at: iso(h.created_at)! })),
    })),
    menus: menus.map((m) => {
      const rows = new Map<
        string,
        {
          meal: string;
          cells: Record<string, { kind: 'ITEM' | 'RECIPE' | 'NONE'; code: string | null; label: string }>;
        }
      >();
      for (const r of mrows.filter((x) => x.menu_id === m.id)) {
        const row = rows.get(r.rid) ?? rows.set(r.rid, { meal: r.meal, cells: {} }).get(r.rid)!;
        if (r.day) row.cells[r.day] = { kind: r.kind, code: r.code, label: r.label };
      }
      return {
        name: m.name,
        legacyIndex: m.legacy_index,
        sortOrder: m.sort_order,
        days: m.days,
        active: m.active,
        rows: [...rows.values()],
      };
    }),
    menuPax: pax.map((p) => ({
      month: p.month,
      day: p.day,
      location: p.location,
      menu: menuName.get(p.menu_id) ?? '',
      people: p.people,
    })),
    production: prod.map((p) => ({
      month: p.month,
      day: p.day,
      location: p.location,
      clientId: p.client_id,
      recipeCode: p.recipe_code,
      portions: p.portions,
    })),
    clients: clientRows.map((c) => ({ id: c.id, brandCode: c.brand_code, name: c.name, active: c.active })),
    stockFrom,
  };
}

/** Months of stock a backup carries (D-75). */
export const STOCK_MONTHS = 13;
/** Rows per stock page, so no response passes the platform limit. */
export const STOCK_PAGE = 20000;

/** One page of the stock a backup carries: the counts or the receipts dated from `stockFrom` on, oldest first. */
export async function buildStockChunk(
  db: Queryable,
  user: SessionUser,
  kind: 'counts' | 'receipts',
  stockFrom: string,
  offset: number,
): Promise<{ items: unknown[]; nextOffset: number | null }> {
  needAdmin(user);
  const d = "to_char(%c, 'YYYY-MM-DD')";
  const { rows } =
    kind === 'counts'
      ? await db.query(
          `SELECT site, ${d.replace('%c', 'count_date')} AS date, code, qty FROM stock_count WHERE count_date >= $1::date
            ORDER BY count_date, site, code OFFSET $2 LIMIT $3`,
          [stockFrom, offset, STOCK_PAGE],
        )
      : await db.query(
          `SELECT site, ${d.replace('%c', 'receipt_date')} AS date, code, qty, ref FROM receipt WHERE receipt_date >= $1::date
            ORDER BY receipt_date, site, code, ref OFFSET $2 LIMIT $3`,
          [stockFrom, offset, STOCK_PAGE],
        );
  return { items: rows, nextOffset: rows.length === STOCK_PAGE ? offset + rows.length : null };
}

/** A chunk of images (photos or logos) under a byte budget, so no response passes the platform limit. */
export async function buildImageChunk(
  db: Queryable,
  user: SessionUser,
  kind: 'photos' | 'logos',
  offset: number,
  budget = IMAGE_CHUNK_BYTES,
): Promise<{ items: { code: string; data: string }[]; nextOffset: number | null }> {
  needAdmin(user);
  const sql =
    kind === 'photos'
      ? `SELECT r.code AS code, p.data FROM recipe_photo p JOIN recipe r ON r.id = p.recipe_id AND r.deleted_at IS NULL ORDER BY r.code OFFSET $1 LIMIT 50`
      : `SELECT b.code AS code, l.data FROM brand_logo l JOIN brand b ON b.id = l.brand_id ORDER BY b.code OFFSET $1 LIMIT 50`;
  const { rows } = await db.query(sql, [offset]);
  const items: { code: string; data: string }[] = [];
  let used = 0;
  for (const r of rows) {
    const b64 = Buffer.from(r.data as Buffer).toString('base64');
    if (items.length && used + b64.length > budget) return { items, nextOffset: offset + items.length };
    items.push({ code: r.code as string, data: b64 });
    used += b64.length;
  }
  return { items, nextOffset: rows.length === 50 ? offset + items.length : null };
}

export interface RestoreStats {
  settings: boolean;
  brands: { added: number; updated: number };
  ingredients: { added: number; updated: number; keptNotInBackup: number };
  recipes: { added: number; updated: number; removed: number };
  menus: { added: number; updated: number; deactivated: number };
  menuPax: number;
  production: number;
  /** null = the file carries no stock (stock left as it is) */
  stockCounts: number | null;
  receipts: number | null;
  /** stock rows skipped: a site no brand lists or a code that is not an ingredient */
  stockSkipped: number;
  photos: number | null;
  logos: number | null;
}

function chunks<T>(a: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}
const B = 1500; // rows per bulk statement

/**
 * Bring the system to the state in the backup, in the caller's (direct) transaction: upsert by CODE, nothing in the audit log or
 * price history is touched, cards absent from the backup are soft-deleted (undoable), ingredients absent from it are kept and
 * counted. Refuses a backup whose recipe graph is circular. Images are replaced only when the backup carries them.
 */
export async function applyRestore(tx: Queryable, user: SessionUser, bk: Backup, file: string): Promise<RestoreStats> {
  needAdmin(user);
  await tx.query('SELECT pg_advisory_xact_lock($1)', [CODE_LOCK]);
  const stats: RestoreStats = {
    settings: true,
    brands: { added: 0, updated: 0 },
    ingredients: { added: 0, updated: 0, keptNotInBackup: 0 },
    recipes: { added: 0, updated: 0, removed: 0 },
    menus: { added: 0, updated: 0, deactivated: 0 },
    menuPax: 0,
    production: 0,
    stockCounts: null,
    receipts: null,
    stockSkipped: 0,
    photos: null,
    logos: null,
  };

  // integrity first: unique codes, no cycles, brands exist
  const recCodes = new Set<string>();
  for (const r of bk.recipes) {
    const k = r.code.toUpperCase();
    if (recCodes.has(k)) throw new ApiError('unprocessable', `The backup holds two cards with the code ${r.code}`);
    recCodes.add(k);
  }
  const ingCodes = new Set<string>();
  for (const i of bk.ingredients) {
    if (ingCodes.has(i.code))
      throw new ApiError('unprocessable', `The backup holds two ingredients with the code ${i.code}`);
    ingCodes.add(i.code);
    if (recCodes.has(i.code.toUpperCase()))
      throw new ApiError('unprocessable', `The code ${i.code} is both an ingredient and a card in the backup`);
  }
  const brandCodes = new Set(bk.brands.map((b) => b.code));
  for (const r of bk.recipes)
    if (!brandCodes.has(r.brandCode))
      throw new ApiError('unprocessable', `Card ${r.code} names the unknown brand ${r.brandCode}`);
  try {
    assertAcyclic(bk.recipes.map((r) => ({ code: r.code, lines: r.lines.map((l) => ({ code: l.code })) })));
  } catch (e) {
    throw new ApiError('unprocessable', e instanceof Error ? e.message : 'The backup contains a circular recipe');
  }

  // settings
  await tx.query(
    `UPDATE cost_settings SET currency=$1, pkg=$2, del=$3, lab=$4, ops=$5, buffer=$6, target=$7, vat=$8, price_date=$9, version = version + 1 WHERE id = 1`,
    [
      bk.settings.currency,
      bk.settings.pkg,
      bk.settings.del,
      bk.settings.lab,
      bk.settings.ops,
      bk.settings.buffer,
      bk.settings.target,
      bk.settings.vat,
      bk.settings.priceDate,
    ],
  );

  // brands (match by legacy id, then by code)
  const have = (await tx.query('SELECT id, legacy_id, code FROM brand')).rows;
  const brandId = new Map<string, string>();
  for (const b of bk.brands) {
    const ex = have.find((x) => x.legacy_id === b.legacyId) ?? have.find((x) => x.code === b.code);
    if (ex) {
      await tx.query(
        `UPDATE brand SET code=$2, name=$3, name_ar=$4, color=$5, ink_color=$6, locations=$7, active=$8 WHERE id=$1`,
        [ex.id, b.code, b.name, b.nameAr, b.color, b.inkColor, b.locations, b.active],
      );
      brandId.set(b.code, ex.id as string);
      stats.brands.updated++;
    } else {
      const r = await tx.query(
        `INSERT INTO brand (legacy_id, code, name, name_ar, color, ink_color, locations, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [b.legacyId, b.code, b.name, b.nameAr, b.color, b.inkColor, b.locations, b.active],
      );
      brandId.set(b.code, r.rows[0]!.id as string);
      stats.brands.added++;
    }
  }

  // ingredients
  for (const part of chunks(bk.ingredients, B)) {
    // D-100 (B2): a restore that changes a price leaves a history row (source RESTORE), like every other price write
    const was = new Map(
      (
        await tx.query('SELECT code, price FROM ingredient WHERE code = ANY($1::text[])', [part.map((i) => i.code)])
      ).rows.map((x) => [x.code as string, x.price as number | null]),
    );
    const r = await tx.query(
      `INSERT INTO ingredient (code, name, uom, price, price_updated_at, category, subcategory, flag, y_thaw, y_cut, y_cook)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::float8[], $5::timestamptz[], $6::text[], $7::text[], $8::text[], $9::float8[], $10::float8[], $11::float8[])
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, uom = EXCLUDED.uom, price = EXCLUDED.price, price_updated_at = EXCLUDED.price_updated_at,
         category = EXCLUDED.category, subcategory = EXCLUDED.subcategory, flag = EXCLUDED.flag,
         y_thaw = EXCLUDED.y_thaw, y_cut = EXCLUDED.y_cut, y_cook = EXCLUDED.y_cook, version = ingredient.version + 1
       RETURNING id, code, (xmax = 0) AS inserted`,
      [
        part.map((i) => i.code),
        part.map((i) => i.name),
        part.map((i) => i.uom),
        part.map((i) => i.price),
        part.map((i) => i.priceUpdatedAt),
        part.map((i) => i.category),
        part.map((i) => i.subcategory),
        part.map((i) => i.flag),
        part.map((i) => i.yThaw ?? null),
        part.map((i) => i.yCut ?? null),
        part.map((i) => i.yCook ?? null),
      ],
    );
    const idOf = new Map(r.rows.map((x) => [x.code as string, x.id as string]));
    for (const x of r.rows) {
      if (x.inserted) stats.ingredients.added++;
      else stats.ingredients.updated++;
    }
    const moved = part.filter((i) => (was.get(i.code) ?? null) !== i.price);
    if (moved.length)
      await tx.query(
        `INSERT INTO ingredient_price_history (ingredient_id, old_price, new_price, source, user_id, user_name_snapshot)
         SELECT * FROM unnest($1::text[], $2::float8[], $3::float8[], $4::text[], $5::text[], $6::text[])`,
        [
          moved.map((i) => idOf.get(i.code)!),
          moved.map((i) => was.get(i.code) ?? null),
          moved.map((i) => i.price),
          moved.map(() => 'RESTORE'),
          moved.map(() => user.id),
          moved.map(() => user.name),
        ],
      );
    const ids = part.map((i) => idOf.get(i.code)!);
    await tx.query('DELETE FROM item_brand_scope WHERE ingredient_id = ANY($1::text[])', [ids]);
    const scopeIng: string[] = [];
    const scopeBr: string[] = [];
    for (const i of part)
      for (const bc of i.brandCodes) {
        const b = brandId.get(bc);
        if (!b) continue;
        scopeIng.push(idOf.get(i.code)!);
        scopeBr.push(b);
      }
    if (scopeIng.length)
      await tx.query(
        'INSERT INTO item_brand_scope (ingredient_id, brand_id) SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT DO NOTHING',
        [scopeIng, scopeBr],
      );
    await tx.query('DELETE FROM unit_conversion WHERE ingredient_id = ANY($1::text[])', [ids]);
    const withConv = part.filter((i) => i.conv);
    if (withConv.length)
      await tx.query(
        'INSERT INTO unit_conversion (ingredient_id, recipe_unit, factor) SELECT * FROM unnest($1::text[], $2::text[], $3::float8[])',
        [
          withConv.map((i) => idOf.get(i.code)!),
          withConv.map((i) => i.conv!.recipeUnit),
          withConv.map((i) => i.conv!.factor),
        ],
      );
  }
  stats.ingredients.keptNotInBackup = Number(
    (
      await tx.query('SELECT count(*) AS n FROM ingredient WHERE NOT (code = ANY($1::text[]))', [
        bk.ingredients.map((i) => i.code),
      ])
    ).rows[0]!.n,
  );

  // recipes: soft-delete the live cards the backup does not contain, then upsert by code
  const live = (await tx.query('SELECT id, code FROM recipe WHERE deleted_at IS NULL')).rows;
  const liveId = new Map(live.map((r) => [(r.code as string).toLowerCase(), r.id as string]));
  const incoming = new Set(bk.recipes.map((r) => r.code.toLowerCase()));
  const gone = live.filter((r) => !incoming.has((r.code as string).toLowerCase())).map((r) => r.id as string);
  if (gone.length)
    await tx.query(
      `UPDATE recipe SET deleted_at = now(), deleted_by = $2, version = version + 1 WHERE id = ANY($1::text[])`,
      [gone, `${user.name} (restore)`],
    );
  stats.recipes.removed = gone.length;
  const idByCode = new Map<string, string>();
  for (const r of bk.recipes) {
    const ex = liveId.get(r.code.toLowerCase());
    const args = [
      r.code,
      r.name,
      r.category,
      r.type,
      brandId.get(r.brandCode),
      r.output,
      r.subQty,
      r.subUom,
      r.batchOut,
      r.batchUom,
      r.sellingPrice,
      r.buffer,
      r.status,
      r.lockedBy,
      r.lockedAt,
      r.costAtLock == null ? null : JSON.stringify(r.costAtLock),
      r.type === 'SUB' ? null : (r.stockClass ?? null),
    ];
    if (ex) {
      await tx.query(
        `UPDATE recipe SET code=$1, name=$2, category=$3, type=$4::recipe_type, brand_id=$5, output=$6, sub_qty=$7, sub_uom=$8, batch_out=$9, batch_uom=$10, selling_price=$11, buffer=$12,
                status=$13::recipe_status, locked_by=$14, locked_at=$15, cost_at_lock=$16::jsonb, stock_class=$17, version = version + 1 WHERE id = $18`,
        [...args, ex],
      );
      idByCode.set(r.code, ex);
      stats.recipes.updated++;
    } else {
      const ins = await tx.query(
        `INSERT INTO recipe (code, name, category, type, brand_id, output, sub_qty, sub_uom, batch_out, batch_uom, selling_price, buffer, status, locked_by, locked_at, cost_at_lock, stock_class)
         VALUES ($1,$2,$3,$4::recipe_type,$5,$6,$7,$8,$9,$10,$11,$12,$13::recipe_status,$14,$15,$16::jsonb,$17) RETURNING id`,
        args,
      );
      idByCode.set(r.code, ins.rows[0]!.id as string);
      stats.recipes.added++;
    }
  }
  const ids = [...idByCode.values()];
  for (const t of ['recipe_line', 'recipe_method_step', 'recipe_history_entry'])
    await tx.query(`DELETE FROM ${t} WHERE recipe_id = ANY($1::text[])`, [ids]);
  type LRow = [
    string,
    number,
    string,
    number,
    string,
    number,
    number | null,
    number | null,
    number | null,
    number | null,
  ];
  const lrows: LRow[] = [];
  const srows: [string, number, string][] = [];
  const hrows: [string, string, string, string][] = [];
  for (const r of bk.recipes) {
    const id = idByCode.get(r.code)!;
    // while any stage is set y is their product (D-70), whatever the file says
    r.lines.forEach((l, i) =>
      lrows.push([
        id,
        i,
        l.code,
        l.qty,
        l.unit,
        stagedYield(l) ?? l.y,
        l.yp,
        l.yThaw ?? null,
        l.yCut ?? null,
        l.yCook ?? null,
      ]),
    );
    r.method.forEach((t, i) => srows.push([id, i + 1, t]));
    r.history.forEach((h) => hrows.push([id, h.action, h.who, h.at]));
  }
  for (const part of chunks(lrows, 3000))
    await tx.query(
      `INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit, y, yp, y_thaw, y_cut, y_cook) SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::float8[], $5::text[], $6::float8[], $7::float8[], $8::float8[], $9::float8[], $10::float8[])`,
      [
        part.map((x) => x[0]),
        part.map((x) => x[1]),
        part.map((x) => x[2]),
        part.map((x) => x[3]),
        part.map((x) => x[4]),
        part.map((x) => x[5]),
        part.map((x) => x[6]),
        part.map((x) => x[7]),
        part.map((x) => x[8]),
        part.map((x) => x[9]),
      ],
    );
  for (const part of chunks(srows, 3000))
    await tx.query(
      `INSERT INTO recipe_method_step (recipe_id, step_number, text) SELECT * FROM unnest($1::text[], $2::int[], $3::text[])`,
      [part.map((x) => x[0]), part.map((x) => x[1]), part.map((x) => x[2])],
    );
  for (const part of chunks(hrows, 3000))
    await tx.query(
      `INSERT INTO recipe_history_entry (recipe_id, action, who, created_at) SELECT a, b::history_action, c, d::timestamptz FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(a,b,c,d)`,
      [part.map((x) => x[0]), part.map((x) => x[1]), part.map((x) => x[2]), part.map((x) => x[3])],
    );

  // menus (by name), rows and cells replaced; menus the backup lacks are deactivated, never deleted
  const menuHave = (await tx.query('SELECT id, name FROM menu')).rows;
  const menuId = new Map<string, string>();
  for (const m of bk.menus) {
    const ex = menuHave.find((x) => String(x.name).toLowerCase() === m.name.toLowerCase());
    let id: string;
    if (ex) {
      await tx.query(
        'UPDATE menu SET name=$2, legacy_index=$3, sort_order=$4, days=$5, active=$6, version = version + 1 WHERE id=$1',
        [ex.id, m.name, m.legacyIndex, m.sortOrder, m.days, m.active],
      );
      id = ex.id as string;
      stats.menus.updated++;
    } else {
      id = (
        await tx.query(
          'INSERT INTO menu (name, legacy_index, sort_order, days, active) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [m.name, m.legacyIndex, m.sortOrder, m.days, m.active],
        )
      ).rows[0]!.id as string;
      stats.menus.added++;
    }
    menuId.set(m.name, id);
    await tx.query('DELETE FROM menu_row WHERE menu_id = $1', [id]);
    for (let i = 0; i < m.rows.length; i++) {
      const row = m.rows[i]!;
      const rid = (
        await tx.query('INSERT INTO menu_row (menu_id, sort_order, meal) VALUES ($1,$2,$3) RETURNING id', [
          id,
          i,
          row.meal,
        ])
      ).rows[0]!.id as string;
      const cells = Object.entries(row.cells);
      if (cells.length)
        await tx.query(
          `INSERT INTO menu_cell (row_id, day, kind, code, label) SELECT $1, d, k::menu_cell_kind, nullif(c,''), l FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS t(d,k,c,l)`,
          [
            rid,
            cells.map(([d]) => d),
            cells.map(([, c]) => c.kind),
            cells.map(([, c]) => c.code ?? ''),
            cells.map(([, c]) => c.label),
          ],
        );
    }
  }
  const dropped = menuHave
    .filter((x) => !bk.menus.some((m) => m.name.toLowerCase() === String(x.name).toLowerCase()))
    .map((x) => x.id as string);
  if (dropped.length)
    await tx.query('UPDATE menu SET active = false, version = version + 1 WHERE id = ANY($1::text[])', [dropped]);
  stats.menus.deactivated = dropped.length;

  // clients (D-71), by brand + name; the backup's ids are translated. A file without clients leaves them alone; one with
  // clients deactivates the ones it lacks (production rows may still point at them), never deletes
  const clientMap = new Map<string, string>();
  if (bk.clients) {
    const seen = new Set<string>();
    for (const c of bk.clients) {
      if (!brandId.has(c.brandCode))
        throw new ApiError('unprocessable', `The backup has the client ${c.name} for the unknown brand ${c.brandCode}`);
      const k = `${c.brandCode}|${c.name.toLowerCase()}`;
      if (seen.has(k))
        throw new ApiError('unprocessable', `The backup holds the client ${c.name} twice for brand ${c.brandCode}`);
      seen.add(k);
    }
    const have = (await tx.query('SELECT id, brand_id, name FROM client')).rows;
    const kept = new Set<string>();
    for (const c of bk.clients) {
      const bid = brandId.get(c.brandCode);
      if (!bid) continue;
      const ex = have.find((x) => x.brand_id === bid && String(x.name).toLowerCase() === c.name.toLowerCase());
      let id: string;
      if (ex) {
        await tx.query('UPDATE client SET name = $2, active = $3, version = version + 1 WHERE id = $1', [
          ex.id,
          c.name,
          c.active,
        ]);
        id = ex.id as string;
      } else
        id = (
          await tx.query('INSERT INTO client (brand_id, name, active) VALUES ($1,$2,$3) RETURNING id', [
            bid,
            c.name,
            c.active,
          ])
        ).rows[0]!.id as string;
      kept.add(id);
      clientMap.set(c.id, id);
    }
    const gone = have.map((x) => x.id as string).filter((id) => !kept.has(id));
    if (gone.length)
      await tx.query('UPDATE client SET active = false, version = version + 1 WHERE id = ANY($1::text[])', [gone]);
  }

  // working data: headcounts and production figures are replaced as a whole
  await tx.query('DELETE FROM menu_pax');
  await tx.query('DELETE FROM production_entry');
  const paxRows = bk.menuPax.filter((p) => menuId.has(p.menu));
  for (const part of chunks(paxRows, 5000))
    await tx.query(
      `INSERT INTO menu_pax (month, day, location, menu_id, people) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[]) ON CONFLICT DO NOTHING`,
      [
        part.map((p) => p.month),
        part.map((p) => p.day),
        part.map((p) => p.location),
        part.map((p) => menuId.get(p.menu)!),
        part.map((p) => p.people),
      ],
    );
  stats.menuPax = paxRows.length;
  for (const part of chunks(bk.production, 5000))
    await tx.query(
      `INSERT INTO production_entry (month, day, location, client_id, recipe_code, portions) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[]) ON CONFLICT DO NOTHING`,
      [
        part.map((p) => p.month),
        part.map((p) => p.day),
        part.map((p) => p.location),
        part.map((p) => (p.clientId ? (clientMap.get(p.clientId) ?? '') : '')), // an unknown client becomes unassigned
        part.map((p) => p.recipeCode),
        part.map((p) => p.portions),
      ],
    );
  stats.production = bk.production.length;

  // stock (D-75, D-83): only when the file carries it. Rows dated from the file's window start on are replaced, older rows stay.
  if (bk.stockCounts || bk.receipts) {
    const counts = bk.stockCounts;
    const rcpts = bk.receipts;
    const days = [...(counts ?? []).map((r) => r.date), ...(rcpts ?? []).map((r) => r.date)];
    const from = bk.stockFrom ?? (days.length ? days.reduce((a, b) => (a < b ? a : b)) : null);
    const sites = new Set(
      (await tx.query('SELECT DISTINCT unnest(locations) AS s FROM brand')).rows.map((r) => r.s as string),
    );
    const codes = [...new Set([...(counts ?? []).map((r) => r.code), ...(rcpts ?? []).map((r) => r.code)])];
    const known = new Set(
      codes.length
        ? (await tx.query('SELECT code FROM ingredient WHERE code = ANY($1::text[])', [codes])).rows.map(
            (r) => r.code as string,
          )
        : [],
    );
    const ok = <T extends { site: string; code: string }>(r: T) => sites.has(r.site) && known.has(r.code);
    if (counts) {
      if (from) await tx.query('DELETE FROM stock_count WHERE count_date >= $1::date', [from]);
      const keep = counts.filter(ok);
      stats.stockSkipped += counts.length - keep.length;
      for (const part of chunks(keep, 5000))
        await tx.query(
          `INSERT INTO stock_count (site, count_date, code, qty) SELECT s, d::date, c, q FROM unnest($1::text[], $2::text[], $3::text[], $4::float8[]) AS t(s,d,c,q) ON CONFLICT DO NOTHING`,
          [part.map((r) => r.site), part.map((r) => r.date), part.map((r) => r.code), part.map((r) => r.qty)],
        );
      stats.stockCounts = keep.length;
    }
    if (rcpts) {
      if (from) await tx.query('DELETE FROM receipt WHERE receipt_date >= $1::date', [from]);
      const keep = rcpts.filter(ok);
      stats.stockSkipped += rcpts.length - keep.length;
      for (const part of chunks(keep, 5000))
        await tx.query(
          `INSERT INTO receipt (site, receipt_date, code, qty, ref) SELECT s, d::date, c, q, f FROM unnest($1::text[], $2::text[], $3::text[], $4::float8[], $5::text[]) AS t(s,d,c,q,f) ON CONFLICT DO NOTHING`,
          [
            part.map((r) => r.site),
            part.map((r) => r.date),
            part.map((r) => r.code),
            part.map((r) => r.qty),
            part.map((r) => r.ref),
          ],
        );
      stats.receipts = keep.length;
    }
  }

  // images, only when the backup carries them (a data-only backup leaves pictures alone)
  if (bk.photos) {
    const photo = pgImageStore(tx, 'photo');
    await tx.query('DELETE FROM recipe_photo WHERE recipe_id = ANY($1::text[])', [ids]);
    let n = 0;
    for (const p of bk.photos) {
      const id = idByCode.get(p.recipeCode);
      if (!id) continue;
      const bytes = new Uint8Array(Buffer.from(p.data, 'base64'));
      await photo.put(id, validateImage(bytes, 'photo'), bytes);
      n++;
    }
    stats.photos = n;
  }
  if (bk.logos) {
    const logo = pgImageStore(tx, 'logo');
    await tx.query('DELETE FROM brand_logo WHERE brand_id = ANY($1::text[])', [[...brandId.values()]]);
    let n = 0;
    for (const l of bk.logos) {
      const id = brandId.get(l.brandCode);
      if (!id) continue;
      const bytes = new Uint8Array(Buffer.from(l.data, 'base64'));
      await logo.put(id, validateImage(bytes, 'logo'), bytes);
      n++;
    }
    stats.logos = n;
  }

  await appendAudit(
    tx,
    user,
    'Restored a backup',
    `${file}: ${stats.recipes.added} cards added, ${stats.recipes.updated} updated, ${stats.recipes.removed} removed (soft); ${stats.ingredients.added} ingredients added, ${stats.ingredients.updated} updated; ${stats.menus.added + stats.menus.updated} menus`,
  );
  return stats;
}
