/**
 * Recipe-card upload parsing — port of legacy RCOLS / RUOM / RSCALE / RBLK / RBLKCOL, the kitchen "block layout" converter
 * and the grouping loop of doImportRecipes (4852-5700). Pure. Library lookups, brand resolution, locked cards and every
 * authorisation rule live on the SERVER (docs/ARCHITECTURE.md §2); this module only turns spreadsheet rows into cards.
 */
import { rnorm } from './items';
import type { Sheet } from '../xlsx/read';
import type { Unit } from '../units';

/** D-17: `Waste %` (yp) and `Card Buffer` are new trailing columns; files without them leave those values untouched. */
export const RTPL_HEAD = [
  'Brand',
  'Recipe Code',
  'Recipe Name',
  'Category',
  'Type',
  'Portions',
  'Batch Output',
  'Batch UOM',
  'Sales Price',
  'Item Code',
  'Ingredient Name',
  'Qty',
  'Unit',
  'Yield %',
  'Method Step',
  'Waste %',
  'Card Buffer',
  'Thaw %',
  'Cut %',
  'Cook %',
];

export const RCOLS: Record<string, string[]> = {
  brand: ['brand', 'brandcode', 'brandname', 'concept', 'conceptname', 'businessunit', 'bu', 'outletbrand'],
  code: ['recipecode', 'code', 'cardcode', 'recipeno', 'cardno'],
  name: ['recipename', 'recipe', 'dish', 'dishname', 'menuitem', 'cardname'],
  cat: ['category', 'cat', 'section', 'group', 'menugroup', 'subcategory'],
  type: ['type', 'recipetype', 'kind', 'cardtype'],
  out: [
    'portions',
    'portion',
    'servings',
    'noofportions',
    'yieldportions',
    'covers',
    'output',
    'outputportions',
    'outputportion',
    'outputqty',
    'portionsperbatch',
    'servingsperbatch',
    'noofservings',
    'numberofportions',
  ],
  bout: ['batchoutput', 'batchoutputqty', 'batchqty', 'batchyield', 'totalyield', 'batch'],
  buom: ['batchuom', 'batchunit', 'outputuom', 'outputunit', 'batchoutputuom'],
  price: ['salesprice', 'sellingprice', 'menuprice', 'price', 'sellprice'],
  icode: ['itemcode', 'ingredientcode', 'materialcode', 'rawmaterialcode', 'sku', 'ingcode', 'productcode'],
  iname: [
    'ingredientname',
    'itemname',
    'ingredient',
    'material',
    'description',
    'nameinrecipe',
    'recipeitemname',
    'itemdescription',
  ],
  qty: ['qty', 'quantity', 'amount', 'recipeqty', 'usage', 'netqty'],
  unit: ['unit', 'recipeunit', 'uom', 'qtyunit', 'usageunit', 'measure'],
  yld: ['yield', 'yieldpct', 'yieldpercent', 'yld', 'usableyield', 'yieldfactor'],
  step: ['methodstep', 'method', 'step', 'instruction', 'instructions', 'procedure', 'preparation', 'directions'],
  yp: ['wastepct', 'waste', 'wastepercent', 'wastage', 'wastagepercent'],
  buf: ['cardbuffer', 'buffer', 'variablebuffer', 'cardbufferpct'],
  // three-stage line yield (D-70, D-85), percent
  ythaw: ['thawpct', 'thaw', 'thawing', 'thawingpct', 'thawyield'],
  ycut: ['cutpct', 'cut', 'cutting', 'cuttingpct', 'trimpct', 'trim', 'trimming', 'cutyield'],
  ycook: ['cookpct', 'cook', 'cooking', 'cookingpct', 'cookyield'],
};

export const RUOM: Record<string, Unit> = {
  gram: 'Gram',
  grams: 'Gram',
  g: 'Gram',
  gm: 'Gram',
  gms: 'Gram',
  ghm: 'Gram',
  gr: 'Gram',
  kg: 'Gram',
  ml: 'Ml',
  millilitre: 'Ml',
  milliliter: 'Ml',
  l: 'Ml',
  litre: 'Ml',
  liter: 'Ml',
  each: 'Each',
  ea: 'Each',
  pc: 'Each',
  pcs: 'Each',
  piece: 'Each',
  unit: 'Each',
  slice: 'Slice',
  slices: 'Slice',
};

/** Bulk units carry a factor ("2 kg" imported as 2 grams before this existed). */
const RSCALE: Record<string, number> = {
  kg: 1000,
  kgs: 1000,
  kilo: 1000,
  kilos: 1000,
  kilogram: 1000,
  kilograms: 1000,
  l: 1000,
  ltr: 1000,
  ltrs: 1000,
  litre: 1000,
  litres: 1000,
  liter: 1000,
  liters: 1000,
};

const RBLK: Record<string, string[]> = {
  name: ['recipe', 'recipename', 'dish', 'dishname', 'item', 'product', 'description', 'menuitem'],
  code: ['recipecode', 'code', 'cardcode', 'ref', 'reference', 'itemcode'],
  cat: ['category', 'cat', 'section', 'group', 'menugroup'],
  price: ['sellingprice', 'salesprice', 'sellprice', 'menuprice', 'price'],
  netcost: ['netcost', 'netcosttotal', 'batchcost', 'recipecost', 'totalbatchcost', 'grosscost'],
  pcost: ['totalcost', 'costperportion', 'costperunit', 'dishcost', 'costpergram', 'costperpiece'],
  out: [
    'outpot',
    'output',
    'outputqty',
    'outputquantity',
    'portions',
    'portion',
    'servings',
    'noofportions',
    'yield',
    'yieldportions',
    'covers',
  ],
  dishwt: ['weightofdish', 'dishweight', 'portionweight', 'weightperportion', 'netweight', 'weight'],
};
const RBLKCOL: Record<string, string[]> = {
  icode: ['code', 'itemcode', 'ingredientcode', 'materialcode', 'sku'],
  iname: ['item', 'itemname', 'ingredient', 'ingredientname', 'material', 'description', 'particulars'],
  unit: ['uom', 'unit', 'um', 'measure', 'recipeunit'],
  qty: ['qpg', 'qty', 'quantity', 'qtypergram', 'amount', 'usage', 'grams', 'gm', 'weight', 'qtyused'],
  ppg: ['ppg', 'priceperunit', 'price', 'unitprice', 'rate', 'pricepergram', 'cost'],
  total: ['total', 'totalcost', 'amount', 'linetotal', 'value', 'extended'],
};

const cell = (v: unknown): string => String(v == null ? '' : v);

function blkLabel(txt: string): string {
  const n = rnorm(txt);
  if (!n) return '';
  for (const k in RBLK) if (RBLK[k]!.includes(n)) return k;
  const bare = n.replace(/[0-9]+$/, ''); // "Variable cost 5%" carries the number in the label
  for (const k in RBLK) if (RBLK[k]!.includes(bare)) return k;
  return '';
}
const looksLikeCode = (v: unknown): boolean => {
  const t = cell(v).trim();
  return /^[A-Za-z]{2,6}[-/ ]?[0-9]{1,6}$/.test(t) || /^[A-Za-z]{2,6}-[A-Za-z]{2,3}-[0-9]{2,6}$/.test(t);
};
function firstNum(row: readonly unknown[], from: number): { v: number; i: number } | null {
  for (let i = from; i < row.length; i++) {
    const t = cell(row[i])
      .replace(/,/g, '')
      .replace(/[^\d.-]/g, '');
    if (t !== '' && t !== '-' && isFinite(parseFloat(t))) return { v: parseFloat(t), i };
  }
  return null;
}
function firstWord(row: readonly unknown[], from: number): { v: string; i: number } | null {
  for (let i = from; i < row.length; i++) {
    const t = cell(row[i]).trim();
    if (t && !/^[\d.,-]+$/.test(t)) return { v: t, i };
  }
  return null;
}

/** Index of the ingredient-table heading row, or -1 when the sheet is not a block sheet (never fires on the flat template). */
export function blockHeaderRow(rows: readonly (readonly unknown[])[]): number {
  const lim = Math.min(rows.length, 40);
  for (let i = 0; i < lim; i++) {
    const cells = (rows[i] ?? []).map(rnorm);
    const has = (set: string[]) => cells.some((c) => c && set.includes(c));
    if (cells.some((c) => ['recipename', 'recipecode', 'brand'].includes(c))) return -1; // flat template
    if (has(RBLKCOL.icode!) && has(RBLKCOL.iname!) && (has(RBLKCOL.qty!) || has(RBLKCOL.total!))) return i;
  }
  return -1;
}

export interface BlockMeta {
  sheet: string;
  name: string;
  code: string;
  cat: string;
  price: number | '';
  out: number | '';
  outUom: string;
  netcost: number | null;
  pcost: number | null;
  dishwt: number | null;
  lines: number;
  seen: number;
  notes: string[];
}

export interface FlatRow {
  brand: string;
  code: string;
  name: string;
  cat: string;
  type: 'Sub' | 'Menu';
  out: number | '';
  bout: '';
  buom: string;
  price: number | '';
  icode: string;
  iname: string;
  qty: number;
  unit: Unit | '';
  yld: '';
  step: '';
  /** true when the unit came from a kg/litre conversion (the library's unit must not override it) */
  scaled: boolean;
  block: true;
}

/** Legacy rBlockConvert (4982): a kitchen sheet (title, label/value stack, line table) -> flat rows. */
export function blockConvert(
  rows: readonly (readonly unknown[])[],
  sheetName: string,
  hdrRow: number,
): { flat: FlatRow[]; meta: BlockMeta } {
  const head = (rows[hdrRow] ?? []).map(rnorm);
  const col: Record<string, number> = {};
  head.forEach((h, i) => {
    if (!h) return;
    for (const k in RBLKCOL) {
      if (col[k] === undefined && RBLKCOL[k]!.includes(h)) {
        col[k] = i;
        return;
      }
    }
  });
  const meta: BlockMeta = {
    sheet: sheetName,
    name: '',
    code: '',
    cat: '',
    price: '',
    out: '',
    outUom: '',
    netcost: null,
    pcost: null,
    dishwt: null,
    lines: 0,
    seen: 0,
    notes: [],
  };

  for (let i = 0; i < hdrRow; i++) {
    const row = rows[i] ?? [];
    let matched = false;
    for (let c = 0; c < row.length; c++) {
      const txt = cell(row[c]).trim();
      if (!txt) continue;
      const key = blkLabel(txt);
      if (!key) continue;
      matched = true;
      const n = firstNum(row, c + 1);
      const w = firstWord(row, c + 1);
      if (key === 'out') {
        if (n && meta.out === '') {
          meta.out = n.v;
          const u = firstWord(row, n.i + 1);
          if (u) meta.outUom = u.v;
        }
      } else if (key === 'price') {
        if (n && meta.price === '') meta.price = n.v;
      } else if (key === 'netcost') {
        if (n && meta.netcost == null) meta.netcost = n.v;
      } else if (key === 'pcost') {
        if (n && meta.pcost == null) meta.pcost = n.v;
      } else if (key === 'dishwt') {
        if (n && meta.dishwt == null) meta.dishwt = n.v;
      } else if (key === 'cat') {
        if (w && !meta.cat && !blkLabel(w.v)) meta.cat = w.v;
      } else if (key === 'name') {
        if (w && !meta.name && !blkLabel(w.v)) meta.name = w.v;
      } else if (key === 'code') {
        if (w && !meta.code && looksLikeCode(w.v)) meta.code = w.v;
      }
    }
    if (!matched) {
      const first = firstWord(row, 0);
      if (!first) continue;
      if (!meta.name && i < 4 && !looksLikeCode(first.v)) {
        meta.name = first.v;
        for (let j = first.i + 1; j < row.length; j++)
          if (looksLikeCode(row[j])) {
            meta.code = cell(row[j]).trim();
            break;
          }
      } else if (!meta.code && looksLikeCode(first.v)) meta.code = first.v;
    } else if (!meta.code) {
      for (let j = 0; j < row.length; j++)
        if (looksLikeCode(row[j])) {
          meta.code = cell(row[j]).trim();
          break;
        }
    }
  }
  if (!meta.name) meta.name = String(sheetName || '').trim();

  const flat: FlatRow[] = [];
  const G = (r: readonly unknown[], k: string) => {
    const i = col[k];
    return i === undefined ? '' : cell(r[i]).trim();
  };
  const type: 'Sub' | 'Menu' = /(^|-)sub(-|$)/i.test(meta.code) || /-SR-/i.test(meta.code) ? 'Sub' : 'Menu';
  for (let i = hdrRow + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const ic = G(r, 'icode');
    const nm = G(r, 'iname');
    if (!ic && !nm) continue;
    if (rnorm(ic) === 'code') continue;
    const qraw = G(r, 'qty').trim();
    const qnum = parseFloat(qraw.replace(/,/g, ''));
    if (qraw === '' || !isFinite(qnum)) continue; // legends and notes live under the table: prose, not a broken ingredient
    meta.seen++;
    if (!ic) {
      meta.notes.push(`"${nm}" has no item code and was left out`);
      continue;
    }
    if (qnum <= 0) {
      meta.notes.push(`${ic} has a quantity of ${qraw} and was left out`);
      continue;
    }
    let qty = qnum;
    const unitRaw = G(r, 'unit');
    const unit: Unit | '' = RUOM[rnorm(unitRaw)] || '';
    const scale = RSCALE[rnorm(unitRaw)];
    if (scale) {
      qty = qty * scale;
      meta.notes.push(`${ic}: ${unitRaw} converted to ${unit || 'Gram'} (${String(qty)})`);
    }
    // PPG / Total in the file are deliberately not read: costing always uses the library price
    flat.push({
      brand: '',
      code: meta.code,
      name: meta.name,
      cat: meta.cat,
      type,
      out: meta.out,
      bout: '',
      buom: meta.outUom && RUOM[rnorm(meta.outUom)] ? RUOM[rnorm(meta.outUom)]! : '',
      price: meta.price,
      icode: ic,
      iname: nm,
      qty,
      unit,
      yld: '',
      step: '',
      scaled: !!scale,
      block: true,
    });
    meta.lines++;
  }
  return { flat, meta };
}

export function mapHeader(row: readonly unknown[]): Record<string, number> {
  const map: Record<string, number> = {};
  const seen: Record<string, 1> = {};
  row.forEach((h, i) => {
    const n = rnorm(h);
    if (!n) return;
    for (const k in RCOLS) {
      if (!(k in seen) && RCOLS[k]!.includes(n)) {
        map[k] = i;
        seen[k] = 1;
        return;
      }
    }
  });
  return map;
}

/** Legacy rYield (5521): blank -> 1; a figure above 1.5 is a percentage; capped at 1. */
export function parseYield(v: unknown): number {
  const s = cell(v).trim();
  if (!s) return 1;
  let n = parseFloat(s.replace('%', ''));
  if (!isFinite(n) || n <= 0) return 1;
  if (n > 1.5) n = n / 100;
  return Math.min(n, 1) || 1;
}

const num = (v: unknown): number | null => {
  const t = cell(v).replace(/,/g, '').replace('%', '').trim();
  if (t === '') return null;
  const n = parseFloat(t);
  return isFinite(n) ? n : null;
};

export interface ImportLine {
  code: string;
  qty: number;
  /** '' = not given: the server uses the library unit of the item (or the sub-recipe's unit) */
  unit: Unit | '';
  y: number;
  /** waste % (D-17); null = not in the file, leave the stored value */
  yp: number | null;
  /** three-stage yield (D-70): fractions as written in the Thaw % / Cut % / Cook % columns (null = blank). null overall = the
   *  file has no such columns, so the stored stages are kept while the Yield % still matches (D-85). */
  stages?: { yThaw: number | null; yCut: number | null; yCook: number | null } | null;
  /** block-sheet line: a different library unit wins unless the quantity was converted from kg / litres */
  block?: { scaled: boolean };
}

export interface ImportCard {
  /** brand text exactly as written (the server resolves it); '' = use the dialog's default brand */
  brand: string;
  code: string;
  name: string;
  cat: string;
  /** Type column text ('' when absent); the server decides sub/menu with the legacy rule */
  type: string;
  out: number | null;
  bout: number | null;
  buom: Unit | '';
  price: number | null;
  /** card buffer as a fraction (D-17); null = leave */
  buffer: number | null;
  lines: ImportLine[];
  method: string[];
  /** 1-based sheet rows this card came from */
  rows: number[];
  /** D-101: the user's choice when the code already exists ('update' it or give the card a 'new' code); set in the review */
  mode?: 'update' | 'new';
}

export interface ParsedRecipes {
  cards: ImportCard[];
  /** findings that are the file's own doing (rows ignored, dropped lines) */
  warn: string[];
  blocks: BlockMeta[];
  hasBrandColumn: boolean;
  /** true when no usable card sheet or table was found at all */
  empty: boolean;
}

/**
 * Legacy doImportRecipes parse phase: any tab shaped like the kitchen's card is converted first, so one workbook can mix
 * both layouts; then rows are grouped into cards (blank key continues the previous card).
 */
export function parseRecipeSheets(sheets: Sheet[]): ParsedRecipes {
  let rows: unknown[][] | null = null;
  const blocks: BlockMeta[] = [];
  let blockRows: unknown[][] = [];
  const blockFlat: FlatRow[] = [];
  for (const sh of sheets) {
    if (/^\s*example/i.test(sh.name || '')) continue; // the template's demo tab
    const hr = blockHeaderRow(sh.rows || []);
    if (hr < 0) {
      if (!rows && (sh.rows || []).length) rows = sh.rows;
      continue;
    }
    const { flat, meta } = blockConvert(sh.rows, sh.name, hr);
    if (!flat.length) {
      if (!meta.seen) continue; // an unfilled template tab: say nothing
      meta.notes.push('no usable ingredient line found');
      blocks.push(meta);
      continue;
    }
    blockFlat.push(...flat);
    blockRows = blockRows.concat(
      flat.map((o) => [
        o.brand,
        o.code,
        o.name,
        o.cat,
        o.type,
        o.out,
        o.bout,
        o.buom,
        o.price,
        o.icode,
        o.iname,
        o.qty,
        o.unit,
        o.yld,
        o.step,
      ]),
    );
    blocks.push(meta);
  }
  if (blockRows.length) rows = [RTPL_HEAD, ...blockRows, ...(rows && rows.length > 1 ? rows.slice(1) : [])];
  if (!rows || rows.length < 2) return { cards: [], warn: [], blocks, hasBrandColumn: false, empty: true };

  let map = mapHeader(rows[0]!);
  let start = 1;
  if (map.icode === undefined && map.name === undefined && map.code === undefined) {
    map = {};
    RTPL_HEAD.forEach((h, i) => {
      const n = rnorm(h);
      for (const k in RCOLS) if (RCOLS[k]!.includes(n) && map[k] === undefined) map[k] = i;
    });
    start = 0;
  }
  const G = (r: readonly unknown[], k: string): string => {
    const i = map[k];
    return i === undefined ? '' : cell(r[i]).trim();
  };
  const byKey = new Map<string, ImportCard>();
  const order: ImportCard[] = [];
  const warn: string[] = [];
  let lastKey = '';
  const exampleCodes = new Set<string>();
  const hasBrandColumn = map.brand !== undefined;
  const hasStages = map.ythaw !== undefined || map.ycut !== undefined || map.ycook !== undefined;

  for (let i = start; i < rows.length; i++) {
    const r = rows[i]!;
    const ln = i + 1;
    const codeRaw = G(r, 'code');
    const nameRaw = G(r, 'name');
    const brandRaw = G(r, 'brand');
    // rows of the template's demo cards repeat the demo code with no name: a code seen on an EXAMPLE row stays skipped
    if (
      /^EXAMPLE/i.test(codeRaw) ||
      /^EXAMPLE\b|delete this row/i.test(nameRaw) ||
      (codeRaw && exampleCodes.has(codeRaw.toUpperCase()))
    ) {
      if (codeRaw) exampleCodes.add(codeRaw.toUpperCase());
      lastKey = '__EX__';
      continue;
    }
    let key = codeRaw || nameRaw ? `${rnorm(brandRaw) || '~'}\u0000${(codeRaw || nameRaw).toUpperCase()}` : '';
    if (!key) key = lastKey;
    if (key === '__EX__') continue;
    if (!key) {
      warn.push(`Row ${ln}: no recipe code or name yet – row ignored`);
      continue;
    }
    lastKey = key;
    let g = byKey.get(key);
    if (!g) {
      g = {
        brand: brandRaw,
        code: codeRaw.toUpperCase(),
        name: nameRaw,
        cat: '',
        type: '',
        out: null,
        bout: null,
        buom: '',
        price: null,
        buffer: null,
        lines: [],
        method: [],
        rows: [],
      };
      byKey.set(key, g);
      order.push(g);
    }
    if (!g.brand && brandRaw) g.brand = brandRaw;
    if (!g.code && codeRaw) g.code = codeRaw.toUpperCase();
    if (!g.name && nameRaw) g.name = nameRaw;
    if (!g.cat) g.cat = G(r, 'cat');
    if (!g.type) g.type = G(r, 'type');
    if (g.out == null) g.out = num(G(r, 'out'));
    if (g.bout == null) g.bout = num(G(r, 'bout'));
    if (!g.buom) g.buom = RUOM[rnorm(G(r, 'buom'))] ?? '';
    if (g.price == null) g.price = num(G(r, 'price'));
    if (g.buffer == null) {
      const b = num(G(r, 'buf'));
      g.buffer = b == null ? null : b > 1.5 ? b / 100 : b; // percent in the file; a bare 0.15 is read as a fraction
    }
    g.rows.push(ln);

    const step = G(r, 'step');
    if (step)
      String(step)
        .split('|')
        .map((x) => x.trim())
        .filter(Boolean)
        .forEach((x) => g!.method.push(x));

    const ic = G(r, 'icode');
    if (!ic) continue;
    const qty = parseFloat(String(G(r, 'qty')).replace(/,/g, ''));
    if (!isFinite(qty) || qty <= 0) {
      warn.push(`Row ${ln}: ${ic} has no usable quantity – line dropped`);
      continue;
    }
    const blockInfo = start === 1 && blockRows.length && i - 1 < blockFlat.length ? blockFlat[i - 1] : undefined;
    const ypv = num(G(r, 'yp'));
    const stage = (k: string, label: string): number | null => {
      const n = num(G(r, k));
      if (n == null) return null;
      const f = n / 100;
      if (f > 0 && f <= 10) return f;
      warn.push(`Row ${ln}: ${label} ${n} is out of range (above 0 and up to 1000) – ignored`);
      return null;
    };
    g.lines.push({
      code: ic,
      qty,
      unit: RUOM[rnorm(G(r, 'unit'))] ?? '',
      y: parseYield(G(r, 'yld')),
      yp: ypv == null ? null : Math.min(99, Math.max(0, ypv)),
      stages: hasStages
        ? { yThaw: stage('ythaw', 'Thaw %'), yCut: stage('ycut', 'Cut %'), yCook: stage('ycook', 'Cook %') }
        : null,
      ...(blockInfo ? { block: { scaled: blockInfo.scaled } } : {}),
    });
  }
  return { cards: order, warn, blocks, hasBrandColumn, empty: order.length === 0 };
}

// ------------------------------------------------------------------ templates

export const blockTplRows = (bufferPct: number): unknown[][] => [
  ['Recipe name here', '', 'MD-001', '', 'PHOTO'],
  [],
  ['Net cost', '', '', ''],
  ['Selling price', '', '', ''],
  ['Net Profit', '', '', '', 'FC%', ''],
  [],
  ['Cost per portion', '', '', ''],
  [],
  ['Output', '', '', 8, 'Gram'],
  ['Weight of dish', '', '', ''],
  ['Total cost', '', '', ''],
  ['Variable cost 5%', '', '', ''],
  [`Dish Cost ${Math.round(bufferPct)}%`, '', '', ''],
  ['Code', 'Item', '', '', '', 'UOM', 'QPG', 'PPG', 'Total'],
  ['DRS4-1654', 'Jarish Seeds', '', '', '', 'GM', 1000, 0.008, ''],
  ['PRD1-4265', 'Fresh onion Yellow(Imported)', '', '', '', 'GM', 200, 0.003529, ''],
  ['', '', '', '', '', '', '', '', ''],
  ['DELETE THE TWO EXAMPLE LINES ABOVE AND ADD YOUR OWN'],
  [],
  ['HOW THIS SHEET IS READ'],
  ['One recipe per tab. Name every tab and add as many as you like – all of them load at once.'],
  ['Only Code and QPG are essential on a line. UOM is taken from the ingredient library when they disagree,'],
  ['because the library knows whether an item is bought by the gram or by the piece.'],
  ['PPG and Total are read for comparison only – costing always uses the library price, so a card'],
  ['never carries a stale price silently.'],
  ['Output is the number of portions. Sales price goes beside Selling price.'],
  ['kg and litre quantities are converted to grams and millilitres automatically.'],
  ['Item codes must already exist in the Ingredient Library, or the line loads at zero cost.'],
];

/** Flat template with worked examples (legacy recipeTplRows 5330), for two brand codes. */
export function recipeTplRows(brandCode: string, otherCode: string): string[][] {
  const b = brandCode || 'FRS';
  const o = otherCode || b;
  const p = `${b}-MN-EX01`;
  const s = `${b}-SR-EX01`;
  const q = `${o}-MN-EX01`;
  const pad = (r: string[]) => [...r, '', ''];
  return [
    pad([
      b,
      s,
      'EXAMPLE – delete this row – Lemon Herb Dressing',
      'Sub-Recipe',
      'Sub',
      '1',
      '500',
      'Ml',
      '',
      'DRS3-1615',
      'Olive Oil',
      '300',
      'Ml',
      '100',
      'Whisk the oil and juice to an emulsion.',
    ]),
    pad([
      b,
      s,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'DRS1-114',
      'Salt',
      '5',
      'Gram',
      '100',
      'Season, then hold chilled up to 3 days.',
    ]),
    pad([
      b,
      p,
      'EXAMPLE – delete this row – Grilled Chicken Salad',
      'Salads',
      'Menu',
      '1',
      '380',
      'Gram',
      '32',
      'PLT1-37',
      'Chicken Breast',
      '160',
      'Gram',
      '75',
      'Grill the marinated breast and rest it.',
    ]),
    pad([
      b,
      p,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'PRD1-230',
      'Lettuce',
      '120',
      'Gram',
      '75',
      'Build the leaves in a chilled bowl.',
    ]),
    pad([
      b,
      p,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      s,
      'Lemon Herb Dressing',
      '30',
      'Ml',
      '100',
      'Dress at the pass and serve immediately.',
    ]),
    pad([
      o,
      q,
      'EXAMPLE – delete this row – same sheet, different brand',
      'Salads',
      'Menu',
      '1',
      '300',
      'Gram',
      '28',
      'PLT1-37',
      'Chicken Breast',
      '140',
      'Gram',
      '75',
      'Same item code, costed from the one price list.',
    ]),
  ];
}
