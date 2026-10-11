/**
 * Stock count / receipt sheet parsing (D-73, slice 2c). Pure: spreadsheet rows in, normalised rows + findings out. The
 * server re-validates everything (site, ingredient scope, dates, duplicates), so this only reads the file.
 */
import { MAX_STOCK_QTY } from '../stock-limits';
import { iCode, rnorm } from './items';

export const SCOLS: Record<string, string[]> = {
  code: ['code', 'itemcode', 'ingredientcode', 'materialcode', 'rawmaterialcode', 'sku', 'productcode', 'articlecode'],
  qty: [
    'quantity',
    'qty',
    'counted',
    'count',
    'countedqty',
    'delivered',
    'received',
    'receivedqty',
    'deliveredqty',
    'onhand',
    'stock',
    'stockonhand',
    'closingstock',
  ],
  site: ['site', 'location', 'store', 'branch', 'kitchen'],
  date: ['date', 'countdate', 'receiptdate', 'deliverydate', 'counteddate', 'stockdate'],
};

export function mapStockHeader(row: readonly unknown[]): Record<string, number> {
  const map: Record<string, number> = {};
  row.forEach((h, i) => {
    const n = rnorm(h);
    if (!n) return;
    for (const k in SCOLS) if (!(k in map) && SCOLS[k]!.includes(n)) return void (map[k] = i);
  });
  return map;
}

export interface StockSheetRow {
  site: string;
  date: string;
  code: string;
  qty: number;
  /** the row number in the file (1 = the header or first row) */
  line: number;
}

export interface ParsedStock {
  rows: StockSheetRow[];
  rejected: string[];
  /** rows with no quantity: "not counted", left out on purpose (not an error) */
  blank: number;
}

/** An ISO date, or an Excel serial number (a date cell read without its format), as YYYY-MM-DD; null when it is neither. */
export function stockDateCell(v: unknown): string | null {
  const t = String(v == null ? '' : v).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  if (/^\d{5}(\.\d+)?$/.test(t)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * One row per ingredient. `fallback` is the site and date shown on the screen: a row without its own site or date cell uses
 * them, so a plain Code + Quantity sheet works. A blank quantity means "not counted" and is skipped; a negative or non-numeric
 * one is rejected by name. A header row is found by its names; without one the order is Code, Quantity.
 */
export function parseStockRows(
  rows: readonly (readonly unknown[])[],
  fallback: { site: string; date: string },
): ParsedStock {
  let map = mapStockHeader(rows[0] ?? []);
  let start = 1;
  if (map.code === undefined) {
    map = { code: 0, qty: 1 }; // no header: the documented order
    start = 0;
  }
  const G = (r: readonly unknown[], k: string): string => {
    const i = map[k];
    return i === undefined ? '' : String(r[i] == null ? '' : r[i]).trim();
  };
  const out: StockSheetRow[] = [];
  const rejected: string[] = [];
  let blank = 0;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i]!;
    const line = i + 1;
    const code = iCode(G(r, 'code'));
    if (!code || /^EXAMPLE/i.test(code)) continue;
    const q = G(r, 'qty');
    if (q === '') {
      blank++;
      continue;
    }
    // a comma is only a thousands separator in a proper grouping (1,200 / 1,200.5); "1,5" is a decimal comma and would
    // silently become 15, so it is refused instead of guessed
    if (q.includes(',') && !/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(q)) {
      rejected.push(`Row ${line} ${code}: quantity "${q}" is ambiguous (use a dot for decimals, e.g. 1.5)`);
      continue;
    }
    const qty = Number(q.replace(/,/g, ''));
    if (!Number.isFinite(qty)) {
      rejected.push(`Row ${line} ${code}: quantity "${q}" is not a number`);
      continue;
    }
    if (qty < 0) {
      rejected.push(`Row ${line} ${code}: quantity is negative`);
      continue;
    }
    if (qty > MAX_STOCK_QTY) {
      rejected.push(`Row ${line} ${code}: quantity is too large`);
      continue;
    }
    const dateCell = G(r, 'date');
    const date = dateCell === '' ? fallback.date : stockDateCell(dateCell);
    if (!date) {
      rejected.push(`Row ${line} ${code}: date "${dateCell}" is not recognised (use YYYY-MM-DD)`);
      continue;
    }
    const site = G(r, 'site') || fallback.site;
    if (!site) {
      rejected.push(`Row ${line} ${code}: no site (add a Site column or pick a site on the screen)`);
      continue;
    }
    out.push({ site, date, code, qty, line });
  }
  return { rows: out, rejected, blank };
}

export const STOCK_TPL_HEAD = ['Site', 'Date', 'Code', 'Item Name', 'Unit', 'Quantity'];
