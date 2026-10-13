/**
 * Raw-material price-list parsing — port of legacy ICOLS / IUOM / iCode / iJunk / iMapHeader / doImportItems' row loop
 * (4605-4730). Pure: rows in, normalised rows + findings out. The server re-validates everything (D-37).
 */
import { parseStagePct } from '@/domain/recipes/yield-stages';

export { parseStagePct };

export const rnorm = (s: unknown): string =>
  String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

export const ICOLS: Record<string, string[]> = {
  pack: [
    'packqty',
    'packsize',
    'packquantity',
    'qtyperpack',
    'unitsperpack',
    'qtygram',
    'gramperitem',
    'gramsperitem',
    'netweight',
    'contents',
  ],
  code: ['code', 'itemcode', 'materialcode', 'rawmaterialcode', 'sku', 'ingredientcode', 'productcode', 'articlecode'],
  name: ['itemname', 'description', 'name', 'ingredientname', 'material', 'particulars', 'itemdescription'],
  uom: ['uom', 'purchaseuom', 'unit', 'purchaseunit', 'baseuom', 'stockuom', 'measure', 'unitofmeasure'],
  price: ['priceperunit', 'price', 'purchaseprice', 'unitprice', 'costperunit', 'cost', 'rate', 'ppg', 'pricepergram'],
  cat: ['maincategory', 'category', 'group', 'cat', 'maingroup', 'store', 'maingroupname'],
  sub: ['subcategory', 'subgroup', 'sub', 'subcat', 'subgroupname', 'secondcategory'],
  // default yield stages in percent (D-93): 'Thawing %', 'Cutting / trimming %', 'Cooking %'
  thaw: ['thawing', 'thaw', 'thawingyield', 'thawyield'],
  cut: ['cuttingtrimming', 'cutting', 'cut', 'trimming', 'cuttingyield', 'cutyield', 'trimmingyield'],
  cook: ['cooking', 'cook', 'cookingyield', 'cookyield'],
};

/** Packaging is bought by the metre and the roll: a price per metre is the same arithmetic as Each (legacy IUOM). */
export const IUOM: Record<string, 'Gram' | 'Ml' | 'Each' | 'Slice'> = {
  kg: 'Gram',
  kgs: 'Gram',
  gramme: 'Gram',
  grammes: 'Gram',
  cc: 'Ml',
  meter: 'Each',
  metre: 'Each',
  meters: 'Each',
  metres: 'Each',
  m: 'Each',
  roll: 'Each',
  rolls: 'Each',
  bag: 'Each',
  box: 'Each',
  packet: 'Each',
  pack: 'Each',
  gram: 'Gram',
  grams: 'Gram',
  g: 'Gram',
  gm: 'Gram',
  gms: 'Gram',
  ghm: 'Gram',
  gr: 'Gram',
  ml: 'Ml',
  millilitre: 'Ml',
  milliliter: 'Ml',
  each: 'Each',
  ea: 'Each',
  pc: 'Each',
  pcs: 'Each',
  piece: 'Each',
  pieces: 'Each',
  unit: 'Each',
  slice: 'Slice',
  slices: 'Slice',
};

/** A code is only ever compared in one shape (legacy iCode 4628). */
export const iCode = (v: unknown): string =>
  String(v == null ? '' : v)
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();

/** Excel wreckage pasted into a text cell ("Fis+A1:F663h & Seafood" was a real example). */
export function iJunk(v: unknown): boolean {
  const t = String(v == null ? '' : v);
  return /#(REF|DIV|VALUE|NAME|N\/A)/i.test(t) || (/:/.test(t) && /\d/.test(t)) || /\+[A-Z]+\d/.test(t);
}

export function mapHeader(row: readonly unknown[]): Record<string, number> {
  const map: Record<string, number> = {};
  const seen: Record<string, 1> = {};
  row.forEach((h, i) => {
    const n = rnorm(h);
    if (!n) return;
    for (const k in ICOLS) {
      if (!(k in seen) && ICOLS[k]!.includes(n)) {
        map[k] = i;
        seen[k] = 1;
        return;
      }
    }
  });
  return map;
}

export interface ImportItem {
  code: string;
  name: string;
  uom: 'Gram' | 'Ml' | 'Each' | 'Slice';
  /** null = the price cell was empty (leave the stored price alone) */
  price: number | null;
  cat: string;
  sub: string;
  line: number;
  /** default yield stages as fractions (D-93): undefined = the cell was blank (leave as is), null = 0 (clear: 100%), else the fraction */
  yThaw?: number | null;
  yCut?: number | null;
  yCook?: number | null;
}

export interface ParsedItems {
  items: ImportItem[];
  rejected: string[];
  /** codes that appeared more than once in the file -> times */
  fileDupes: Record<string, number>;
  junk: string[];
}

const STAGE_LABEL = { thaw: 'thawing %', cut: 'cutting / trimming %', cook: 'cooking %' } as const;

/** Legacy doImportItems row loop: header detection, unit/price validation, last row for a code wins. */
export function parseItemRows(rows: readonly (readonly unknown[])[]): ParsedItems {
  let map = mapHeader(rows[0] ?? []);
  let start = 1;
  if (map.code === undefined) {
    map = { code: 0, name: 1, uom: 2, price: 3, cat: 4, sub: 5 }; // no header: the documented order
    start = 0;
  }
  const G = (r: readonly unknown[], k: string): string => {
    const i = map[k];
    return i === undefined ? '' : String(r[i] == null ? '' : r[i]).trim();
  };
  const plan = new Map<string, ImportItem>();
  const order: string[] = [];
  const rejected: string[] = [];
  const fileDupes: Record<string, number> = {};
  const junk: string[] = [];

  for (let i = start; i < rows.length; i++) {
    const r = rows[i]!;
    const ln = i + 1;
    const code = iCode(G(r, 'code'));
    if (!code) continue;
    if (/^EXAMPLE/i.test(code)) continue;
    const uomRaw = G(r, 'uom');
    const uom = IUOM[rnorm(uomRaw)];
    if (!uom) {
      rejected.push(`Row ${ln} ${code}: unit "${uomRaw || 'blank'}" not recognised`);
      continue;
    }
    const pTxt = G(r, 'price');
    let price: number | null = null;
    if (pTxt !== '') {
      const p = parseFloat(pTxt.replace(/,/g, ''));
      if (!isFinite(p)) {
        rejected.push(`Row ${ln} ${code}: price "${pTxt}" is not a number`);
        continue;
      }
      if (p < 0) {
        rejected.push(`Row ${ln} ${code}: price is negative`);
        continue;
      }
      price = p;
    }
    const st: Record<'thaw' | 'cut' | 'cook', number | null | undefined> = {
      thaw: undefined,
      cut: undefined,
      cook: undefined,
    };
    let bad = false;
    for (const k of ['thaw', 'cut', 'cook'] as const) {
      const y = parseStagePct(G(r, k));
      if (y === 'bad') {
        rejected.push(
          `Row ${ln} ${code}: ${STAGE_LABEL[k]} "${G(r, k)}" must be a percent above 0 and up to 1000 (0 or blank = 100%)`,
        );
        bad = true;
      } else st[k] = y;
    }
    if (bad) continue;
    let cat = G(r, 'cat');
    let sub = G(r, 'sub');
    if (cat && iJunk(cat)) {
      junk.push(`${code} group "${cat}"`);
      cat = '';
    }
    if (sub && iJunk(sub)) {
      junk.push(`${code} sub group "${sub}"`);
      sub = '';
    }
    if (plan.has(code)) fileDupes[code] = (fileDupes[code] || 1) + 1;
    else order.push(code);
    const row: ImportItem = { code, name: G(r, 'name'), uom, price, cat, sub, line: ln };
    if (!bad) {
      if (st.thaw !== undefined) row.yThaw = st.thaw;
      if (st.cut !== undefined) row.yCut = st.cut;
      if (st.cook !== undefined) row.yCook = st.cook;
    }
    plan.set(code, row); // last row for a code wins
  }
  return { items: order.map((c) => plan.get(c)!), rejected, fileDupes, junk };
}

export const ITEM_YIELD_HEAD = ['Thawing %', 'Cutting / trimming %', 'Cooking %'];
export const TPL_HEAD = ['Code', 'Item Name', 'UOM', 'Price', 'Main Category', 'Sub Category', ...ITEM_YIELD_HEAD];
export const tplRows = (): string[][] => [
  ['EXAMPLE-001', 'Delete this row - Fresh Tomato', 'Gram', '0.004535', 'Fresh', 'Produce', '', '90', ''],
  ['EXAMPLE-002', 'Delete this row - Olive Oil', 'Ml', '0.012000', 'Dry', 'Oils', '', '', ''],
  ['EXAMPLE-003', 'Delete this row - Burger Box', 'Each', '0.350000', 'Non Food', 'Packaging', '', '', ''],
];
