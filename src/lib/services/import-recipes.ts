import { createHash } from 'node:crypto';
import { z } from 'zod';
import { batch, num, type CostContext } from '@/domain/costing';
import { findCycle } from '@/domain/recipes/graph';
import { rnorm } from '../import/items';
import type { SessionUser } from '../auth/types';
import type { Queryable } from '../db/client';
import { loadCatalog } from '../db/catalog';
import { appendAudit } from '../db/repo/audit';
import { canSeeBrand, type BrandScope } from '../db/scope';
import { ApiError } from '../errors';
import { can } from '../permissions';
import { BATCH_UNITS, UNITS } from '../validation/common';
import { CODE_LOCK } from './ingredients';
import { nextCode } from './recipes';

export const MAX_IMPORT_CARDS = 100;
export const MAX_IMPORT_LINES = 3000;

export const importCardIn = z.object({
  brand: z.string().trim().max(80).default(''),
  code: z.string().trim().max(60).default(''),
  name: z.string().trim().max(200).default(''),
  cat: z.string().trim().max(100).default(''),
  type: z.string().trim().max(30).default(''),
  out: z.number().finite().min(0).max(1e6).nullable().default(null),
  bout: z.number().finite().min(0).max(1e9).nullable().default(null),
  buom: z.enum([...BATCH_UNITS, '']).default(''),
  price: z.number().finite().min(0).max(1e7).nullable().default(null),
  buffer: z.number().finite().min(0).max(10).nullable().default(null),
  lines: z
    .array(
      z.object({
        code: z.string().trim().min(1).max(60),
        qty: z.number().finite().gt(0).max(1e9),
        unit: z.enum([...UNITS, '']).default(''),
        y: z.number().finite().gt(0).max(10).default(1),
        yp: z.number().finite().min(0).max(1000).nullable().default(null),
        block: z.object({ scaled: z.boolean() }).optional(),
      }),
    )
    .max(500),
  method: z.array(z.string().max(2000)).max(200).default([]),
  rows: z.array(z.number().int()).max(1000).default([]),
});
export type ImportCardIn = z.output<typeof importCardIn>;

export const recipeImportIn = z.object({
  cards: z.array(importCardIn).min(1).max(MAX_IMPORT_CARDS),
  defaultBrandId: z.string().min(1).max(64),
  takePrice: z.boolean().default(false),
  allowUpdate: z.boolean().default(true),
  grant: z.boolean().default(true),
  file: z.string().trim().max(200).default('recipe file'),
  hash: z.string().max(80).optional(),
});
export type RecipeImportIn = z.output<typeof recipeImportIn>;

export type CardAction = 'add' | 'update' | 'locked' | 'exists' | 'nolines' | 'blocked';

export interface PlannedLine {
  code: string;
  qty: number;
  unit: string;
  y: number;
  yp: number | null;
}
export interface CardPlan {
  index: number;
  code: string;
  name: string;
  type: 'MENU' | 'SUB';
  brandId: string;
  brandName: string;
  brandCode: string;
  action: CardAction;
  reason?: string;
  targetId?: string;
  movesFrom?: string;
  badBrand?: string;
  lines: PlannedLine[];
  unknown: string[];
  conv: string[];
  noPrice: number;
  noPriceCodes: string[];
  pkgLines: number;
  libCost: number;
  out: number;
}

export interface RecipeImportPlan {
  cards: CardPlan[];
  counts: { add: number; update: number; locked: number; exists: number; nolines: number; blocked: number; lines: number };
  perBrand: Record<string, { name: string; code: string; add: number; upd: number; lines: number }>;
  needGrant: number;
  hash: string;
}

interface Internal extends RecipeImportPlan {
  grants: Map<string, { itemId: string; brandId: string }>;
  inputs: { card: ImportCardIn; plan: CardPlan; prevLines: { code: string; yp: number | null }[] }[];
}

const hashOf = (i: RecipeImportIn) => createHash('sha256').update(JSON.stringify([i.cards, i.defaultBrandId, i.takePrice, i.allowUpdate, i.grant])).digest('hex');

/** Legacy rBrandId (5512): code, full name, Arabic name, or a prefix of either. */
function brandIdFor(txt: string, brands: { id: string; code: string; name: string; nameAr: string | null }[]): string {
  const n = rnorm(txt);
  if (!n) return '';
  const b =
    brands.find((x) => rnorm(x.code) === n) ||
    brands.find((x) => rnorm(x.name) === n) ||
    brands.find((x) => rnorm(x.nameAr ?? '') === n) ||
    brands.find((x) => rnorm(x.name).startsWith(n) && n.length >= 3) ||
    brands.find((x) => n.startsWith(rnorm(x.code)) && rnorm(x.code).length >= 3);
  return b ? b.id : '';
}

async function build(tx: Queryable, user: SessionUser, scope: BrandScope, input: RecipeImportIn): Promise<Internal> {
  if (!can(user.role, 'recipe.create')) throw new ApiError('forbidden', 'Your role cannot do that');
  if (input.cards.reduce((a, c) => a + c.lines.length, 0) > MAX_IMPORT_LINES) throw new ApiError('too_large', `At most ${MAX_IMPORT_LINES} lines per part`);
  if (user.role !== 'gm' && !scope.brandIds.includes(input.defaultBrandId)) throw new ApiError('forbidden', 'You have no access to that brand');

  const brands = (await tx.query('SELECT id, code, name, name_ar FROM brand')).rows.map((r) => ({ id: r.id as string, code: r.code as string, name: r.name as string, nameAr: r.name_ar as string | null }));
  const brandById = new Map(brands.map((b) => [b.id, b]));
  if (!brandById.has(input.defaultBrandId)) throw new ApiError('bad_request', 'Unknown brand');

  const catalog = await loadCatalog(tx);
  const ctx: CostContext = catalog.context;
  const itemScope = new Map<string, { id: string; brandIds: string[]; category: string }>();
  const sc = await tx.query(
    `SELECT i.id, i.code, i.category, coalesce((SELECT array_agg(s.brand_id) FROM item_brand_scope s WHERE s.ingredient_id = i.id), '{}') AS brand_ids FROM ingredient i`,
  );
  for (const r of sc.rows) itemScope.set(r.code as string, { id: r.id as string, brandIds: r.brand_ids as string[], category: r.category as string });

  const recipeUpper = new Map<string, string>(); // UPPER code -> exact code
  for (const code of Object.keys(catalog.cards)) recipeUpper.set(code.toUpperCase(), code);
  const itemUpper = new Set([...ctx.items.keys()].map((c) => c.toUpperCase()));

  const grants = new Map<string, { itemId: string; brandId: string }>();
  const cards: CardPlan[] = [];
  const inputs: Internal['inputs'] = [];
  const seenCodes = new Set<string>();
  const counts = { add: 0, update: 0, locked: 0, exists: 0, nolines: 0, blocked: 0, lines: 0 };
  const perBrand: RecipeImportPlan['perBrand'] = {};

  for (let i = 0; i < input.cards.length; i++) {
    const c = input.cards[i]!;
    const code = c.code.toUpperCase();
    let badBrand: string | undefined;
    let bid = brandIdFor(c.brand, brands);
    if (c.brand && !bid) badBrand = c.brand;
    if (!bid) bid = input.defaultBrandId;
    const brand = brandById.get(bid)!;
    const typeR: 'MENU' | 'SUB' = /^s/i.test(c.type) || /-SR-/i.test(code) ? 'SUB' : 'MENU';
    const plan: CardPlan = {
      index: i, code, name: c.name, type: typeR, brandId: bid, brandName: brand.name, brandCode: brand.code, action: 'add', badBrand,
      lines: [], unknown: [], conv: [], noPrice: 0, noPriceCodes: [], pkgLines: 0, libCost: 0, out: Math.max(1, c.out || 1),
    };
    cards.push(plan);
    let prevLines: { code: string; yp: number | null }[] = [];

    const block = (reason: string) => {
      plan.action = 'blocked';
      plan.reason = plan.reason ? `${plan.reason}; ${reason}` : reason;
    };
    if (user.role !== 'gm' && !canSeeBrand(scope, bid)) block(`you have no access to ${brand.name}`);
    if (code && seenCodes.has(code)) block(`the code ${code} appears twice in this part of the file`);
    if (code) seenCodes.add(code);

    // target: by code anywhere, else by brand + normalised name
    let target: { id: string; brandId: string; status: 'DRAFT' | 'LOCKED'; code: string } | undefined;
    if (code) {
      const ex = recipeUpper.get(code);
      if (ex) target = { ...catalog.cards[ex]!, code: ex };
    } else if (rnorm(c.name)) {
      for (const [k, meta] of Object.entries(catalog.cards)) {
        const rec = ctx.recipes.get(k);
        if (rec && meta.brandId === bid && rnorm(rec.name) === rnorm(c.name)) {
          target = { ...meta, code: k };
          break;
        }
      }
    }
    if (target) {
      plan.targetId = target.id;
      plan.code = target.code;
      if (!canSeeBrand(scope, target.brandId)) block('that card belongs to a brand you cannot edit');
      else if (target.brandId !== bid) {
        if (canSeeBrand(scope, bid)) plan.movesFrom = brandById.get(target.brandId)?.name;
        else block(`it would move the card out of ${brandById.get(target.brandId)?.name ?? 'its brand'}`);
      }
      const rows = await tx.query('SELECT code, yp FROM recipe_line WHERE recipe_id = $1 ORDER BY sort_order', [target.id]);
      prevLines = rows.rows.map((r) => ({ code: r.code as string, yp: r.yp as number | null }));
    } else if (code && itemUpper.has(code)) block(`the code ${code} is already used by an ingredient`);

    // lines: items visible to the caller (or granted), or visible sub-recipes
    const lines: PlannedLine[] = [];
    for (const l of c.lines) {
      const it = ctx.items.get(l.code);
      const sco = it ? itemScope.get(l.code) : undefined;
      const sub = !it ? ctx.recipes.get(l.code) : undefined;
      const subMeta = sub ? catalog.cards[sub.code] : undefined;
      if (it) {
        const callerSees = !sco!.brandIds.length || sco!.brandIds.some((b) => scope.brandIds.includes(b));
        if (!callerSees) {
          plan.unknown.push(l.code);
          continue;
        }
        if (sco!.brandIds.length && !sco!.brandIds.includes(bid) && input.grant) grants.set(`${l.code}|${bid}`, { itemId: sco!.id, brandId: bid });
      } else if (sub && sub.type === 'sub' && subMeta && canSeeBrand(scope, subMeta.brandId)) {
        /* visible sub-recipe */
      } else {
        plan.unknown.push(l.code);
        continue;
      }
      let unit: string = l.unit;
      const libUom = it ? it.uom : sub ? sub.subUom || 'Gram' : '';
      if (l.block && !l.block.scaled && libUom && unit && unit !== libUom) unit = libUom;
      if (!unit) unit = libUom || 'Gram';
      let yp = l.yp;
      if (yp === null) {
        const k = prevLines.findIndex((p) => p.code === l.code);
        if (k >= 0) yp = prevLines.splice(k, 1)[0]!.yp; // D-17: a file without a Waste % column leaves the stored value
      }
      lines.push({ code: l.code, qty: l.qty, unit, y: l.y, yp });
      if (it) {
        const lu = unit.toLowerCase();
        const pu = it.uom.toLowerCase();
        const conv = ctx.conv.get(l.code);
        if (lu && pu && lu !== pu && !(conv && num(conv[1]))) plan.conv.push(`${l.code} – ${it.name} (${it.uom} → ${unit})`);
        if (rnorm(sco!.category) === 'nonfood') plan.pkgLines++;
        if (it.price == null || !num(it.price)) {
          plan.noPrice++;
          plan.noPriceCodes.push(`${l.code} – ${it.name}`);
        }
      }
    }
    plan.lines = lines;
    if (plan.unknown.length) block(`unknown or unavailable item code(s): ${[...new Set(plan.unknown)].slice(0, 5).join(', ')}`);
    plan.libCost = batch({ code: '', name: '', type: 'menu', output: 1, subQty: 0, subUom: 'Gram', batchOut: 0, batchUom: 'Gram', price: 0, lines }, ctx).total;

    if (plan.action !== 'blocked') {
      if (!c.lines.length) plan.action = 'nolines';
      else if (target && target.status === 'LOCKED') plan.action = 'locked';
      else if (target && !input.allowUpdate) plan.action = 'exists';
      else plan.action = target ? 'update' : 'add';
    }
    counts[plan.action === 'blocked' ? 'blocked' : plan.action]++;
    counts.lines += plan.action === 'add' || plan.action === 'update' ? lines.length : 0;
    if (plan.action === 'add' || plan.action === 'update') {
      const pb = (perBrand[bid] ||= { name: brand.name, code: brand.code, add: 0, upd: 0, lines: 0 });
      if (plan.action === 'add') pb.add++;
      else pb.upd++;
      pb.lines += lines.length;
    }
    inputs.push({ card: c, plan, prevLines });
  }

  // D-13: the combined graph (stored cards + this file) must stay acyclic
  const graph = await tx.query(
    `SELECT r.code, coalesce(array_agg(l.code) FILTER (WHERE l.code IS NOT NULL AND l.code <> ''), '{}') AS lines
       FROM recipe r LEFT JOIN recipe_line l ON l.recipe_id = r.id WHERE r.deleted_at IS NULL GROUP BY r.id, r.code`,
  );
  const nodes = new Map<string, { code: string; lines: { code: string }[] }>(
    graph.rows.map((r) => [(r.code as string).toUpperCase(), { code: r.code as string, lines: (r.lines as string[]).map((c) => ({ code: c })) }]),
  );
  for (const { plan } of inputs) {
    if (plan.action !== 'add' && plan.action !== 'update') continue;
    nodes.set((plan.code || `\u0000new${plan.index}`).toUpperCase(), { code: plan.code || `__new${plan.index}`, lines: plan.lines.map((l) => ({ code: l.code })) });
  }
  const cycle = findCycle([...nodes.values()]);
  if (cycle) {
    const inCycle = new Set(cycle.map((c) => c.toUpperCase()));
    for (const { plan } of inputs)
      if ((plan.action === 'add' || plan.action === 'update') && inCycle.has(plan.code.toUpperCase())) {
        plan.action = 'blocked';
        plan.reason = `it would create a circular recipe: ${cycle.join(' → ')}`;
        counts.blocked++;
        counts[plan.targetId ? 'update' : 'add']--;
      }
  }

  return { cards, counts, perBrand, needGrant: grants.size, hash: hashOf(input), grants, inputs };
}

export async function previewRecipeImport(tx: Queryable, user: SessionUser, scope: BrandScope, input: RecipeImportIn): Promise<RecipeImportPlan> {
  const p = await build(tx, user, scope, input);
  return { cards: p.cards, counts: p.counts, perBrand: p.perBrand, needGrant: p.needGrant, hash: p.hash };
}

/** Applies one part of a recipe upload in the caller's transaction: all or nothing, locked cards skipped, nothing deleted. */
export async function commitRecipeImport(tx: Queryable, user: SessionUser, scope: BrandScope, input: RecipeImportIn): Promise<{ added: number; updated: number; granted: number; brands: string[] }> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [CODE_LOCK]);
  const p = await build(tx, user, scope, input);
  if (!input.hash || input.hash !== p.hash) throw new ApiError('conflict', 'The file changed since it was checked - check it again');
  if (p.counts.blocked)
    throw new ApiError('unprocessable', `${p.counts.blocked} card(s) cannot be loaded - fix the file and check it again`, {
      blocked: p.cards.filter((c) => c.action === 'blocked').slice(0, 20).map((c) => ({ code: c.code, name: c.name, reason: c.reason })),
    });

  let granted = 0;
  if (input.grant)
    for (const g of p.grants.values()) {
      await tx.query('INSERT INTO item_brand_scope (ingredient_id, brand_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [g.itemId, g.brandId]);
      granted++;
    }

  let added = 0;
  let updated = 0;
  const brandsHit = new Set<string>();
  for (const { card, plan } of p.inputs) {
    if (plan.action !== 'add' && plan.action !== 'update') continue;
    brandsHit.add(plan.brandCode);
    const method = card.method.length ? card.method : [''];
    const out = plan.out;
    const bout = card.bout ?? 0;
    const buom = card.buom || 'Gram';
    const sp = card.price;
    let id: string;
    if (plan.action === 'update') {
      id = plan.targetId!;
      const cur = (await tx.query('SELECT status FROM recipe WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur || cur.status === 'LOCKED') continue; // locked since the check: skipped, never overwritten
      await tx.query(
        `UPDATE recipe SET name = coalesce(nullif($2,''), name), category = coalesce(nullif($3,''), category), type = $4::recipe_type, brand_id = $5,
                output = $6,
                batch_out = CASE WHEN $7::float8 > 0 THEN $7 ELSE batch_out END,
                batch_uom = CASE WHEN $7::float8 > 0 THEN $8 ELSE batch_uom END,
                sub_qty = CASE WHEN $4::recipe_type = 'SUB' AND $7::float8 > 0 THEN $7 ELSE sub_qty END,
                sub_uom = CASE WHEN $4::recipe_type = 'SUB' AND $7::float8 > 0 THEN $8 ELSE sub_uom END,
                selling_price = CASE WHEN $9 AND $10::float8 IS NOT NULL THEN $10 ELSE selling_price END,
                buffer = CASE WHEN $11::float8 IS NOT NULL THEN $11 ELSE buffer END,
                version = version + 1 WHERE id = $1`,
        [id, plan.name, card.cat, plan.type, plan.brandId, out, bout, buom, input.takePrice, sp, card.buffer],
      );
      await tx.query('DELETE FROM recipe_line WHERE recipe_id = $1', [id]);
      await tx.query('DELETE FROM recipe_method_step WHERE recipe_id = $1', [id]);
      updated++;
    } else {
      const code = plan.code || (await nextCode(tx, plan.brandId, plan.type));
      const ins = await tx.query(
        `INSERT INTO recipe (code, name, category, type, brand_id, output, sub_qty, sub_uom, batch_out, batch_uom, selling_price, buffer)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$10,$11) RETURNING id`,
        [code, plan.name || code, card.cat, plan.type, plan.brandId, out, plan.type === 'SUB' ? bout : 0, buom, bout, input.takePrice && sp != null ? sp : 0, card.buffer],
      );
      id = ins.rows[0]!.id as string;
      added++;
    }
    const L = plan.lines;
    await tx.query(
      `INSERT INTO recipe_line (recipe_id, sort_order, code, qty, unit, y, yp)
       SELECT $1, o, c, q, u, y, yp FROM unnest($2::int[], $3::text[], $4::float8[], $5::text[], $6::float8[], $7::float8[]) AS t(o,c,q,u,y,yp)`,
      [id, L.map((_, i) => i), L.map((l) => l.code), L.map((l) => l.qty), L.map((l) => l.unit), L.map((l) => l.y), L.map((l) => l.yp)],
    );
    await tx.query(`INSERT INTO recipe_method_step (recipe_id, step_number, text) SELECT $1, n, t FROM unnest($2::int[], $3::text[]) AS x(n,t)`, [id, method.map((_, i) => i + 1), method]);
  }
  const bl = [...brandsHit].join(' ');
  await appendAudit(
    tx,
    user,
    'Uploaded recipe cards',
    `${added} added, ${updated} updated across ${brandsHit.size} brand(${bl}) · prices ${input.takePrice ? 'incl. sales price from file' : 'kept from the system'}${granted ? ` · ${granted} ingredient access grants` : ''} · source ${input.file}`,
  );
  return { added, updated, granted, brands: [...brandsHit] };
}
