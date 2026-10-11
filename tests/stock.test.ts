import { describe, expect, it } from 'vitest';
import { latestStockDate, stockSaveIn } from '@/lib/services/stock';
import { MAX_STOCK_CELLS, MAX_STOCK_QTY } from '@/lib/stock-limits';

const ok = { site: 'NIC', date: '2026-10-11', kind: 'count', cells: [{ code: 'A-1', qty: 3 }] };
const bad = (o: object) => stockSaveIn.safeParse({ ...ok, ...o });

describe('stock save input (D-73)', () => {
  it('accepts a count and a receipt; null clears; 0 is a real value', () => {
    expect(stockSaveIn.safeParse(ok).success).toBe(true);
    expect(bad({ kind: 'receipt' }).success).toBe(true);
    expect(
      bad({
        cells: [
          { code: 'A-1', qty: null },
          { code: 'A-2', qty: 0 },
        ],
      }).success,
    ).toBe(true);
  });
  it('rejects a bad kind, site, date, quantity or cell list', () => {
    expect(bad({ kind: 'sale' }).success).toBe(false);
    expect(bad({ site: '' }).success).toBe(false);
    expect(bad({ site: 'A|B' }).success).toBe(false);
    expect(bad({ date: '2026-02-30' }).success).toBe(false);
    expect(bad({ date: '11/10/2026' }).success).toBe(false);
    expect(bad({ cells: [{ code: 'A-1', qty: -1 }] }).success).toBe(false);
    expect(bad({ cells: [{ code: 'A-1', qty: NaN }] }).success).toBe(false);
    expect(bad({ cells: [{ code: 'A-1', qty: Infinity }] }).success).toBe(false);
    expect(bad({ cells: [{ code: 'A-1', qty: MAX_STOCK_QTY + 1 }] }).success).toBe(false);
    expect(bad({ cells: [{ code: 'A-1', qty: MAX_STOCK_QTY }] }).success).toBe(true);
    expect(bad({ cells: [{ code: '', qty: 1 }] }).success).toBe(false);
    expect(bad({ cells: [] }).success).toBe(false);
    expect(
      bad({ cells: Array.from({ length: MAX_STOCK_CELLS + 1 }, (_, i) => ({ code: `C-${i}`, qty: 1 })) }).success,
    ).toBe(false);
  });
  it('the latest allowed date is tomorrow in UTC (a day of slack for time zones)', () => {
    expect(latestStockDate(Date.UTC(2026, 9, 11, 23, 0))).toBe('2026-10-12');
    expect(latestStockDate(Date.UTC(2026, 11, 31, 12, 0))).toBe('2027-01-01');
  });
});
