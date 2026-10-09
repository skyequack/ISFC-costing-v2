/**
 * Domain input types for the costing engine. Field names follow the LEGACY card shape on purpose
 * (price = selling price, y/yp per line, buffer per card) so the port stays line-for-line with
 * legacy/app.html 1362-1480. The data layer maps DB columns (sellingPrice, ...) onto these.
 * Values are typed `number` but the engine coerces with num() exactly like legacy (strings/NaN safe).
 */
export interface CostItem {
  code: string;
  name: string;
  uom: string;
  /** null = PRICE MISSING; never coerced to 0 in storage (resolve() does it, as legacy). */
  price: number | null;
}

export interface CostLine {
  code: string;
  qty: number;
  unit: string;
  y?: number | null;
  /** Percent (15 = 15%). null/undefined falls back to the card buffer, then settings.buffer. 0 stays 0. */
  yp?: number | null;
}

export interface CostRecipe {
  id?: string;
  code: string;
  name: string;
  type: 'sub' | 'menu';
  output: number;
  subQty: number;
  subUom: string;
  batchOut: number;
  batchUom: string;
  /** Selling price, ex-VAT. */
  price: number;
  buffer?: number | null;
  lines: CostLine[];
}

export interface CostSettings {
  pkg: number;
  del: number;
  lab: number;
  ops: number;
  buffer: number;
  target: number;
  vat: number;
}

/** [recipeUnit, recipeUnitsPerPurchaseUnit] — legacy S.conv[code]. */
export type ConvEntry = readonly [string, number];

export interface CostContext {
  items: ReadonlyMap<string, CostItem>;
  /** Exact-code index; on duplicate codes the LAST card wins (legacy reindex()). */
  recipes: ReadonlyMap<string, CostRecipe>;
  conv: ReadonlyMap<string, ConvEntry>;
  settings: CostSettings;
}

export interface Resolved {
  name: string;
  uom: string;
  price: number;
  kind: 'item' | 'sub' | 'menu' | 'none';
  err: string;
}

export interface LineCost extends Resolved {
  qty: number;
  q: number;
  gross: number;
  cost: number;
  conv: boolean;
  needConv: boolean;
  y: number;
}

export interface BatchRow {
  line: CostLine;
  cost: number;
}

export interface BatchResult {
  total: number;
  err: string;
  rows: BatchRow[];
}

export interface CostResult {
  batch: number;
  err: string;
  out: number;
  orig: number;
  food: number;
  pkg: number;
  del: number;
  lab: number;
  ops: number;
  totalCost: number;
  net: number;
  sp: number;
  fcPct: number | null;
  tcPct: number | null;
  npPct: number | null;
  gramTotal: number;
  mlTotal: number;
  eaTotal: number;
  autoOut: number;
  autoUom: string;
  bOut: number;
  bUom: string;
  manualOut: boolean;
  portion: number;
  weight: number;
  suggest: number;
  vatPrice: number;
  unitCost: number | null;
}

export function buildContext(
  items: Iterable<CostItem>,
  recipes: Iterable<CostRecipe>,
  conv: Iterable<readonly [string, ConvEntry]>,
  settings: CostSettings,
): CostContext {
  const im = new Map<string, CostItem>();
  for (const i of items) im.set(i.code, i);
  const rm = new Map<string, CostRecipe>();
  for (const r of recipes) rm.set(r.code, r); // last wins
  return { items: im, recipes: rm, conv: new Map(conv), settings };
}
