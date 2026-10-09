/**
 * Costing engine — LINE-FOR-LINE port of legacy/app.html 1362-1480 (docs/legacy/02-costing-engine.md).
 * JS doubles, no rounding, no Decimal. Pure: no cache (cache at the data-loader level), no I/O.
 * Do not "improve" this file; any behaviour change needs a DECISIONS.md row first.
 */
import type {
  ConvEntry,
  BatchResult,
  CostContext,
  CostLine,
  CostRecipe,
  CostResult,
  LineCost,
  Resolved,
} from './types';

/** legacy num(): parseFloat, 0 when not finite. */
export function num(v: unknown): number {
  const n = parseFloat(v as string);
  return isFinite(n) ? n : 0;
}

export function subUnitCost(rec: CostRecipe, ctx: CostContext, seen?: Set<string>): { v: number; err: string } {
  seen = seen || new Set();
  if (seen.has(rec.code)) return { v: 0, err: 'circular' };
  seen.add(rec.code);
  const c = batch(rec, ctx, seen);
  const q = num(rec.batchOut) || num(rec.subQty) || 0;
  if (!q) return { v: 0, err: 'no batch output' };
  /* Raw unit cost - NO buffer (applied exactly once, in cost()). */
  return { v: c.total / q, err: c.err };
}

export function resolve(code: string, ctx: CostContext, seen?: Set<string>): Resolved {
  const it = ctx.items.get(code);
  if (it)
    return {
      name: it.name,
      uom: it.uom,
      price: it.price == null ? 0 : it.price,
      kind: 'item',
      err: it.price == null ? 'no price' : '',
    };
  const r = ctx.recipes.get(code);
  if (r && r.type === 'sub') {
    const s = subUnitCost(r, ctx, seen);
    return { name: r.name, uom: r.subUom || 'Gram', price: s.v, kind: 'sub', err: s.err };
  }
  if (r) return { name: r.name, uom: '', price: 0, kind: 'menu', err: 'not a sub-recipe' };
  return { name: 'CODE NOT FOUND', uom: '', price: 0, kind: 'none', err: 'unknown code' };
}

/**
 * Unit bridge between a line's unit and the resolved purchase/batch unit (legacy lineCost 1397-1411).
 * Units differ and a stored factor exists for exactly the line's unit -> divide by it; units differ
 * otherwise -> the line needs a conversion (costs 0, flagged). Shared with requisition valuation and issues.
 */
export function unitBridge(
  code: string,
  lineUnit: string,
  uom: string,
  conv: ReadonlyMap<string, ConvEntry>,
): { need: boolean; factor: number | null } {
  const lu = (lineUnit || '').toLowerCase().trim(),
    pu = (uom || '').toLowerCase().trim();
  if (!(lu && pu && lu !== pu)) return { need: false, factor: null };
  const f = conv.get(code);
  const fu = f
    ? String(f[0] || '')
        .toLowerCase()
        .trim()
    : '';
  if (f && num(f[1]) && fu === lu) return { need: false, factor: num(f[1]) };
  return { need: true, factor: null };
}

export function lineCost(l: CostLine, ctx: CostContext, seen?: Set<string>): LineCost {
  const r = resolve(l.code, ctx, seen);
  /* A yield outside (0,10] is a data error: treat as 1. */
  const qty = num(l.qty),
    yRaw = num(l.y),
    y = yRaw > 0 && yRaw <= 10 ? yRaw : 1;
  let q = qty,
    conv = false,
    needConv = false;
  const br = unitBridge(l.code, l.unit, r.uom, ctx.conv);
  if (br.need) needConv = true;
  else if (br.factor !== null) {
    q = qty / br.factor;
    conv = true;
  }
  const gross = y ? q / y : q;
  /* No usable bridge: the line costs nothing and stays flagged. */
  const cost = needConv ? 0 : gross * r.price;
  return { ...r, qty, q, gross, cost, conv, needConv, y };
}

export function batch(rec: CostRecipe, ctx: CostContext, seen?: Set<string>): BatchResult {
  let total = 0,
    err = '';
  const rows: BatchResult['rows'] = [];
  (rec.lines || []).forEach((l) => {
    if (!l.code) return;
    const c = lineCost(l, ctx, seen ? new Set(seen) : undefined);
    total += c.cost;
    rows.push({ line: l, cost: c.cost });
    /* A missing conversion takes precedence over any other error. */
    if (c.needConv) err = 'missing unit conversion';
    else if (c.err && !err) err = c.err;
  });
  return { total, err, rows };
}

export function cost(rec: CostRecipe, ctx: CostContext): CostResult {
  const st = ctx.settings,
    b = batch(rec, ctx);
  const out = Math.max(1, num(rec.output) || 1);
  const orig = b.total / out;
  const buf = rec && rec.buffer != null ? num(rec.buffer) : num(st.buffer);
  let yielded = 0;
  (b.rows || []).forEach((x) => {
    const p = x.line && x.line.yp != null ? num(x.line.yp) / 100 : buf;
    yielded += num(x.cost) * (1 + p);
  });
  const food = (yielded || orig * (1 + buf)) / out;
  const sp = num(rec.price);
  const pkg = sp * num(st.pkg),
    del = sp * num(st.del),
    lab = sp * num(st.lab),
    ops = sp * num(st.ops);
  const totalCost = food + pkg + del + lab + ops;
  const net = sp - totalCost;
  let g = 0,
    ml = 0,
    ea = 0;
  (rec.lines || []).forEach((l) => {
    if (!l.code) return;
    const u = (l.unit || '').toLowerCase();
    if (u === 'gram') g += num(l.qty);
    else if (u === 'ml') ml += num(l.qty);
    else ea += num(l.qty);
  });
  const autoOut = g || ml || ea,
    autoUom = g ? 'Gram' : ml ? 'Ml' : 'Each';
  const manual = num(rec.batchOut);
  const bOut = manual || autoOut;
  const bUom = manual ? rec.batchUom || autoUom : autoUom;
  return {
    batch: b.total,
    err: b.err,
    out,
    orig,
    food,
    pkg,
    del,
    lab,
    ops,
    totalCost,
    net,
    sp,
    fcPct: sp ? food / sp : null,
    tcPct: sp ? totalCost / sp : null,
    npPct: sp ? net / sp : null,
    gramTotal: g,
    mlTotal: ml,
    eaTotal: ea,
    autoOut,
    autoUom,
    bOut,
    bUom,
    manualOut: !!manual,
    portion: out ? bOut / out : 0,
    weight: g / out,
    suggest: num(st.target) ? food / num(st.target) : 0,
    vatPrice: sp * (1 + num(st.vat)),
    unitCost: rec.type === 'sub' ? subUnitCost(rec, ctx).v : null,
  };
}
