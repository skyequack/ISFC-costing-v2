/**
 * Requisition / production expansion. SEPARATE from costing (docs/legacy/02 §7) — do not unify.
 * Quantity semantics are legacy reqExpand (legacy/app.html 2101-2118, D-10): depth <= 4, y = num(y)||1 (unclamped),
 * any-type case-insensitive sub match (first match in list order), line qty of a sub-recipe line treated as portions,
 * '?code' bucket for unknown codes. NEW (D-10/D-28): valuation applies the same unit conversion as costing,
 * and unconvertible lines, depth truncation, and sub-recipe scale mismatches are FLAGGED, never silent.
 */
import {
  cost,
  num,
  unitBridge,
  type ConvEntry,
  type CostItem,
  type CostLine,
  type CostRecipe,
  type CostSettings,
} from '../costing';
import { buildContext } from '../costing/types';

export interface ReqContext {
  items: ReadonlyMap<string, CostItem>;
  /** In list order: reqExpand's `find` takes the FIRST case-insensitive match. */
  recipes: ReadonlyArray<CostRecipe>;
  conv: ReadonlyMap<string, ConvEntry>;
}

export interface ReqEntry {
  code: string;
  name: string;
  uom: string;
  /** Legacy issue quantity (in the recipe lines' units, summed as legacy did). */
  qty: number;
  /** Quantity in the item's purchase unit (after conversion); unconvertible lines add 0. */
  purchaseQty: number;
  /** Conversion-aware value (D-10). Label in UI: "issue value, excl. waste buffer". */
  cost: number;
  from: Record<string, number>;
}

export type ReqFlag =
  | { kind: 'unconvertible'; recipe: string; code: string; lineUnit: string; itemUom: string }
  | { kind: 'truncated'; recipe: string; depth: number }
  | { kind: 'unknown-code'; recipe: string; code: string }
  | { kind: 'no-price'; recipe: string; code: string }
  /** Informational (D-47): legacy read the line qty as portions; the quantity of the batch unit is applied instead. */
  | { kind: 'sub-scale'; recipe: string; sub: string; legacyPortions: number; appliedPortions: number };

export interface ReqResult {
  acc: Record<string, ReqEntry>;
  flags: ReqFlag[];
}

export function newReqResult(): ReqResult {
  return { acc: {}, flags: [] };
}

/* Flags are deduplicated per result: the same problem reached over many paths/portions is one flag. */
const flagKeys = new WeakMap<ReqResult, Set<string>>();
function flag(res: ReqResult, f: ReqFlag): void {
  let keys = flagKeys.get(res);
  if (!keys) flagKeys.set(res, (keys = new Set()));
  const k = [f.kind, f.recipe, 'code' in f ? f.code : 'sub' in f ? f.sub : '', 'lineUnit' in f ? f.lineUnit : ''].join(
    '|',
  );
  if (keys.has(k)) return;
  keys.add(k);
  res.flags.push(f);
}

/* First case-insensitive match per code (the contract of the old find()), built once per recipes array and rebuilt
   if the array has grown or shrunk since, so appending to a context between calls is still seen. */
const recipeIdx = new WeakMap<ReadonlyArray<CostRecipe>, { n: number; map: Map<string, CostRecipe> }>();
function recipeByCode(list: ReadonlyArray<CostRecipe>, upper: string): CostRecipe | undefined {
  let e = recipeIdx.get(list);
  if (!e || e.n !== list.length) {
    const map = new Map<string, CostRecipe>();
    for (const x of list) {
      const k = (x.code || '').toUpperCase();
      if (!map.has(k)) map.set(k, x);
    }
    recipeIdx.set(list, (e = { n: list.length, map }));
  }
  return e.map.get(upper);
}

/** One ingredient line reached by the expansion (a leaf: the code is a library item). Read-only observation, never changes the math. */
export interface ReqLineEvent {
  recipe: CostRecipe;
  line: CostLine;
  /** portions of `recipe` being expanded when the line was reached */
  portions: number;
  /** the recipe's output, as used for q */
  out: number;
  /** unit bridge: false = the line unit cannot be converted (the line adds 0 to purchaseQty) */
  convertible: boolean;
  /** divisor from line unit to purchase unit; null = same unit */
  factor: number | null;
}

export function reqExpand(
  r: CostRecipe | null | undefined,
  portions: number,
  ctx: ReqContext,
  res: ReqResult,
  depth = 0,
  onLine?: (e: ReqLineEvent) => void,
): void {
  if (!r) return;
  if (depth > 4) {
    flag(res, { kind: 'truncated', recipe: r.code, depth });
    return;
  }
  const out = Math.max(1, num(r.output) || 1);
  (r.lines || []).forEach((l) => {
    if (!l.code) return; // blank rows carry nothing (D-46); costing skips them too
    const y = num(l.y) || 1;
    const q = ((num(l.qty) / out) * portions) / y;
    const want = String(l.code || '').toUpperCase();
    const sub = recipeByCode(ctx.recipes, want);
    if (sub) {
      const subQ = num(sub.batchOut) || num(sub.subQty) || 0;
      const subOut = Math.max(1, num(sub.output) || 1);
      /* D-47: a line pointing at a sub-recipe is a quantity of its batch unit (as costing reads it), so the
         sub is expanded for qty/batch-size batches = qty x output/batchSize portions. Legacy passed q as portions. */
      let subPortions = q;
      if (subQ) {
        subPortions = q * (subOut / subQ);
        if (Math.abs(subPortions - q) > 1e-9 * Math.max(1, Math.abs(q)))
          flag(res, {
            kind: 'sub-scale',
            recipe: r.code,
            sub: sub.code,
            legacyPortions: q,
            appliedPortions: subPortions,
          });
      }
      reqExpand(sub, subPortions, ctx, res, depth + 1, onLine);
      return;
    }
    const it = ctx.items.get(l.code);
    if (!it) {
      const k = '?' + l.code;
      const e =
        res.acc[k] ||
        (res.acc[k] = { code: l.code, name: '(not in library)', uom: '', qty: 0, purchaseQty: 0, cost: 0, from: {} });
      e.qty += q;
      flag(res, { kind: 'unknown-code', recipe: r.code, code: l.code });
      return;
    }
    const k = it.code;
    const e =
      res.acc[k] || (res.acc[k] = { code: k, name: it.name, uom: it.uom, qty: 0, purchaseQty: 0, cost: 0, from: {} });
    e.qty += q;
    e.from[r.name] = (e.from[r.name] || 0) + q;

    /* conversion-aware valuation: identical rule to costing lineCost() */
    const br = unitBridge(l.code, l.unit, it.uom, ctx.conv);
    const ok = !br.need;
    onLine?.({ recipe: r, line: l, portions, out, convertible: ok, factor: br.factor });
    const pq = br.factor !== null ? q / br.factor : q;
    if (!ok) {
      flag(res, { kind: 'unconvertible', recipe: r.code, code: l.code, lineUnit: l.unit, itemUom: it.uom });
      return;
    }
    if (it.price == null) flag(res, { kind: 'no-price', recipe: r.code, code: l.code });
    e.purchaseQty += pq;
    e.cost += pq * num(it.price);
  });
}

export function requisitionTotal(res: ReqResult): number {
  return Object.values(res.acc).reduce((a, e) => a + e.cost, 0);
}

export interface ReconcileRow {
  code: string;
  name: string;
  portions: number;
  /** requisition value for `portions` (conversion-aware, no buffer) */
  requisitionValue: number;
  /** cost(card).batch * portions/output — card cost BEFORE waste buffer, the like-for-like figure */
  cardValueExBuffer: number;
  /** portions x cost(card).food — card cost including buffer/yp */
  cardValueWithBuffer: number;
  /** requisitionValue - cardValueExBuffer */
  variance: number;
  /** variance of the buffer alone: cardValueWithBuffer - cardValueExBuffer */
  bufferAllowance: number;
  matches: boolean;
  flags: ReqFlag[];
}

/** D-28 reconciliation: requisition value vs portions x card cost, per card, with the flags that explain any variance. */
export function reconcile(
  cards: ReadonlyArray<{ recipe: CostRecipe; portions: number }>,
  ctx: ReqContext,
  settings: CostSettings,
  tolerance = 1e-9,
): ReconcileRow[] {
  const cctx = buildContext(ctx.items.values(), ctx.recipes, ctx.conv.entries(), settings);
  return cards.map(({ recipe, portions }) => {
    const res = newReqResult();
    reqExpand(recipe, portions, ctx, res);
    const c = cost(recipe, cctx);
    const out = Math.max(1, num(recipe.output) || 1);
    const requisitionValue = requisitionTotal(res);
    const cardValueExBuffer = (c.batch * portions) / out;
    const cardValueWithBuffer = c.food * portions;
    const variance = requisitionValue - cardValueExBuffer;
    return {
      code: recipe.code,
      name: recipe.name,
      portions,
      requisitionValue,
      cardValueExBuffer,
      cardValueWithBuffer,
      variance,
      bufferAllowance: cardValueWithBuffer - cardValueExBuffer,
      matches: Math.abs(variance) <= tolerance * Math.max(1, Math.abs(cardValueExBuffer)),
      flags: res.flags,
    };
  });
}
