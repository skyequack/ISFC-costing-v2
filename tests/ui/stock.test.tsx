// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls, installFetch, nav, onFetch, renderInShell, resetFetch } from './harness';

vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh }),
}));
vi.mock('@clerk/nextjs', () => ({ useClerk: () => ({ signOut: vi.fn() }) }));

import { StockScreen, STOCK_PAGE } from '@/components/screens/StockScreen';
import { DATE_COMMIT_MS } from '@/components/shared/DateField';
import type { StockGrid } from '@/lib/services/stock';

beforeAll(() => {
  installFetch();
  window.scrollTo = vi.fn();
});
beforeEach(() => resetFetch());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const grid = (over: Partial<StockGrid> = {}): StockGrid => ({
  sites: ['NIC', 'NEOM'],
  site: 'NIC',
  date: '2026-10-10',
  kind: 'count',
  rows: [
    { code: 'FLOUR', name: 'Flour', uom: 'Gram', qty: 5, other: 0 },
    { code: 'RICE', name: 'Rice', uom: 'Gram', qty: null, other: 0 },
    { code: 'SALT', name: 'Salt', uom: 'Gram', qty: 0, other: 0 },
  ],
  ...over,
});
const box = (code: string) => screen.getByLabelText(`${code} quantity`) as HTMLInputElement;
const type = (code: string, v: string) => fireEvent.change(box(code), { target: { value: v } });
const puts = () => calls.filter((c) => c.method === 'PUT');

describe('Stock screen (D-73)', () => {
  it('shows the stored value, nothing where nothing is stored, and 0 where it was counted empty', () => {
    renderInShell(<StockScreen grid={grid()} />, 'chef');
    expect(box('FLOUR').value).toBe('5');
    expect(box('RICE').value).toBe('');
    expect(box('SALT').value).toBe('0');
  });

  it('saves only the cells that changed; a blank clears; an edit put back to its stored value is not a change', async () => {
    renderInShell(<StockScreen grid={grid()} />, 'cook');
    expect((screen.getByText('Save all') as HTMLButtonElement).disabled).toBe(true);
    type('RICE', '12.5');
    type('FLOUR', '');
    type('SALT', '3');
    type('SALT', '0'); // back to what is stored
    expect(screen.getByText('2 unsaved')).toBeTruthy();
    fireEvent.click(screen.getByText('Save all'));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toMatchObject({
      url: '/api/stock',
      body: {
        site: 'NIC',
        date: '2026-10-10',
        kind: 'count',
        cells: [
          { code: 'FLOUR', qty: null },
          { code: 'RICE', qty: 12.5 },
        ],
      },
    });
  });

  it('refuses a quantity that is not a number of 0 or more, and shows the server error if a save fails', async () => {
    renderInShell(<StockScreen grid={grid()} />, 'chef');
    type('RICE', '-4');
    fireEvent.click(screen.getByText('Save all'));
    expect(await screen.findByText(/RICE: enter a number of 0 or more/)).toBeTruthy();
    expect(puts()).toHaveLength(0);
    type('RICE', '4');
    onFetch((c) =>
      c.method === 'PUT'
        ? { status: 422, json: { error: { code: 'unprocessable', message: 'Not an ingredient you can use: RICE' } } }
        : undefined,
    );
    fireEvent.click(screen.getByText('Save all'));
    expect(await screen.findByText(/Not an ingredient you can use/)).toBeTruthy();
  });

  it('a viewer sees the numbers as text, with "View only" and no Save', () => {
    renderInShell(<StockScreen grid={grid()} />, 'viewer');
    expect(screen.getByText('View only')).toBeTruthy();
    expect(screen.queryByLabelText('FLOUR quantity')).toBeNull();
    expect(screen.queryByText('Save all')).toBeNull();
    expect(screen.getByText('FLOUR')).toBeTruthy();
  });

  it('search and "Entered only" narrow the list', () => {
    renderInShell(<StockScreen grid={grid()} />, 'chef');
    fireEvent.change(screen.getByPlaceholderText('Search ingredient or code'), { target: { value: 'sal' } });
    expect(screen.queryByLabelText('FLOUR quantity')).toBeNull();
    expect(box('SALT')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Search ingredient or code'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('Entered only'));
    expect(screen.queryByLabelText('RICE quantity')).toBeNull(); // nothing stored for it
    expect(box('FLOUR')).toBeTruthy();
    expect(box('SALT')).toBeTruthy(); // 0 was counted: it is entered
    fireEvent.click(screen.getByLabelText('Entered only'));
    type('RICE', '1'); // typing a value makes it "entered" at once
    fireEvent.click(screen.getByLabelText('Entered only'));
    expect(box('RICE')).toBeTruthy();
  });

  it('pages a long list by 100 rows', () => {
    const rows = Array.from({ length: STOCK_PAGE * 2 + 50 }, (_, i) => ({
      code: `C${String(i).padStart(4, '0')}`,
      name: `Item ${i}`,
      uom: 'Gram',
      qty: null,
      other: 0,
    }));
    renderInShell(<StockScreen grid={grid({ rows })} />, 'chef');
    expect(screen.getByText('1–100 of 250')).toBeTruthy();
    expect(screen.queryByLabelText('C0100 quantity')).toBeNull();
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('101–200 of 250')).toBeTruthy();
    expect(box('C0100')).toBeTruthy();
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('201–250 of 250')).toBeTruthy();
    expect((screen.getByText('Next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('changing site, date or kind goes to the URL; with unsaved changes it asks first', () => {
    renderInShell(<StockScreen grid={grid()} />, 'chef');
    fireEvent.change(screen.getByDisplayValue('NIC'), { target: { value: 'NEOM' } });
    expect(String(nav.replace.mock.calls.at(-1)?.[0])).toBe('/stock?site=NEOM&date=2026-10-10&kind=count');
    fireEvent.click(screen.getByText('Receipt'));
    expect(String(nav.replace.mock.calls.at(-1)?.[0])).toBe('/stock?site=NIC&date=2026-10-10&kind=receipt');
    nav.replace.mockClear();
    type('RICE', '3');
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByText('Receipt'));
    expect(ask).toHaveBeenCalledOnce();
    expect(nav.replace).not.toHaveBeenCalled(); // stayed
    ask.mockReturnValue(true);
    fireEvent.click(screen.getByText('Receipt'));
    expect(nav.replace).toHaveBeenCalledOnce();
  });

  it('typing a date does not navigate per keystroke: intermediate years and a blank are ignored, the final date is applied after a pause', () => {
    vi.useFakeTimers();
    try {
      renderInShell(<StockScreen grid={grid()} />, 'chef');
      const date = () => screen.getByLabelText('Date') as HTMLInputElement;
      for (const v of ['0002-10-10', '0202-10-10', '']) {
        fireEvent.change(date(), { target: { value: v } });
        vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
        fireEvent.blur(date());
      }
      expect(nav.replace).not.toHaveBeenCalled();
      fireEvent.change(date(), { target: { value: '2026-10-09' } });
      expect(date().value).toBe('2026-10-09'); // kept while typing
      vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
      expect(nav.replace).toHaveBeenCalledOnce();
      expect(String(nav.replace.mock.calls[0]?.[0])).toBe('/stock?site=NIC&date=2026-10-09&kind=count');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the receipt view adds a column for deliveries that came from uploaded files', () => {
    const g = grid({ kind: 'receipt', rows: [{ code: 'FLOUR', name: 'Flour', uom: 'Gram', qty: 2, other: 11 }] });
    renderInShell(<StockScreen grid={g} />, 'chef');
    const row = screen.getByText('FLOUR').closest('tr')!;
    expect(screen.getByText('Other deliveries')).toBeTruthy();
    expect(within(row).getByText('11')).toBeTruthy();
    expect(box('FLOUR').value).toBe('2');
  });

  it('with no sites it says so instead of showing an empty grid', () => {
    renderInShell(<StockScreen grid={grid({ sites: [], site: '', rows: [] })} />, 'chef');
    expect(screen.getByText('No sites yet.')).toBeTruthy();
  });
});
