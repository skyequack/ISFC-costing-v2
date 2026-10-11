import { describe, expect, it } from 'vitest';
import { mapStockHeader, parseStockRows, stockDateCell } from '@/lib/import/stock';
import { MAX_STOCK_QTY } from '@/lib/stock-limits';

const fb = { site: 'NIC', date: '2026-10-10' };

describe('stock sheet parsing (D-73, slice 2c)', () => {
  it('finds the columns by their heading, in any order', () => {
    expect(mapStockHeader(['Item Name', 'Quantity', 'Item Code', 'Store', 'Count Date'])).toEqual({
      qty: 1,
      code: 2,
      site: 3,
      date: 4,
    });
    expect(mapStockHeader(['SKU', 'Delivered'])).toEqual({ code: 0, qty: 1 });
    expect(mapStockHeader(['foo', 'bar'])).toEqual({});
  });

  it('reads Code + Quantity rows with the screen site and date as the default', () => {
    const p = parseStockRows(
      [
        ['Code', 'Quantity'],
        ['flour', '12.5'],
        ['  rice  ', '1,200'],
        ['salt', '0'],
      ],
      fb,
    );
    expect(p.rows).toEqual([
      { site: 'NIC', date: '2026-10-10', code: 'FLOUR', qty: 12.5, line: 2 },
      { site: 'NIC', date: '2026-10-10', code: 'RICE', qty: 1200, line: 3 },
      { site: 'NIC', date: '2026-10-10', code: 'SALT', qty: 0, line: 4 }, // 0 is a count, not "blank"
    ]);
    expect(p.rejected).toEqual([]);
    expect(p.blank).toBe(0);
  });

  it('a row can carry its own site and date; an Excel serial number is a date', () => {
    const p = parseStockRows(
      [
        ['Code', 'Quantity', 'Site', 'Date'],
        ['A', '1', 'NEOM', '2026-09-30'],
        ['B', '2', '', ''],
        ['C', '3', 'JUBAIL', '46303'], // serial 46303 = 2026-10-08
      ],
      fb,
    );
    expect(p.rows.map((r) => [r.code, r.site, r.date])).toEqual([
      ['A', 'NEOM', '2026-09-30'],
      ['B', 'NIC', '2026-10-10'],
      ['C', 'JUBAIL', '2026-10-08'],
    ]);
    expect(stockDateCell('2026-10-01T00:00:00Z')).toBe('2026-10-01');
    expect(stockDateCell('10/01/2026')).toBeNull();
    expect(stockDateCell('soon')).toBeNull();
  });

  it('a blank quantity is "not counted": skipped and counted, never an error and never 0', () => {
    const p = parseStockRows(
      [
        ['Code', 'Quantity'],
        ['A', ''],
        ['B', '   '],
        ['C', '5'],
      ],
      fb,
    );
    expect(p.rows.map((r) => r.code)).toEqual(['C']);
    expect(p.blank).toBe(2);
    expect(p.rejected).toEqual([]);
  });

  it('rejects, by row and code, a quantity that is not a number, negative or too large, and a date or site it cannot use', () => {
    const p = parseStockRows(
      [
        ['Code', 'Quantity', 'Date'],
        ['A', 'lots', ''],
        ['B', '-1', ''],
        ['C', String(MAX_STOCK_QTY + 1), ''],
        ['D', '1', '31/12/2026'],
        ['E', '1', ''],
      ],
      fb,
    );
    expect(p.rows.map((r) => r.code)).toEqual(['E']);
    expect(p.rejected).toEqual([
      'Row 2 A: quantity "lots" is not a number',
      'Row 3 B: quantity is negative',
      'Row 4 C: quantity is too large',
      'Row 5 D: date "31/12/2026" is not recognised (use YYYY-MM-DD)',
    ]);
    const noSite = parseStockRows(
      [
        ['Code', 'Quantity'],
        ['A', '1'],
      ],
      { site: '', date: '2026-10-10' },
    );
    expect(noSite.rejected[0]).toMatch(/no site/);
  });

  it('works without a header (Code, Quantity), skips example rows and blank codes, and never reads a formula as a code', () => {
    const p = parseStockRows(
      [
        ['A-1', '4'],
        ['EXAMPLE-001', '9'],
        ['', '3'],
        ['=1+1', '2'],
      ],
      fb,
    );
    expect(p.rows.map((r) => [r.code, r.qty, r.line])).toEqual([
      ['A-1', 4, 1],
      ['=1+1', 2, 4], // kept as text; the server will not find it in the catalog and refuses it
    ]);
  });
});
