// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls, installFetch, nav, onFetch, renderInShell, resetFetch } from './harness';

vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh }),
}));
vi.mock('@clerk/nextjs', () => ({ useClerk: () => ({ signOut: vi.fn() }) }));

const saved = vi.hoisted(() => ({ csv: [] as unknown[][][] }));
vi.mock('@/components/io/download', async (orig) => {
  const actual = await orig<typeof import('@/components/io/download')>();
  return {
    ...actual,
    saveCsv: (_name: string, rows: unknown[][]) => void saved.csv.push(rows),
    readFileBytes: async (f: File) => new TextEncoder().encode(await f.text()),
  };
});

import { StockScreen } from '@/components/screens/StockScreen';
import type { StockImportPlan } from '@/lib/services/import-stock';
import type { StockGrid } from '@/lib/services/stock';

beforeAll(() => {
  installFetch();
  window.scrollTo = vi.fn();
});
beforeEach(() => {
  resetFetch();
  saved.csv.length = 0;
});
afterEach(() => cleanup());

const grid = (kind: 'count' | 'receipt' = 'count'): StockGrid => ({
  sites: ['NIC', 'NEOM'],
  site: 'NIC',
  date: '2026-10-10',
  kind,
  rows: [
    { code: 'FLOUR', name: 'Flour', uom: 'Gram', qty: 5, other: 0 },
    { code: 'RICE', name: 'Rice', uom: 'Gram', qty: null, other: 0 },
  ],
});

const plan = (over: Partial<StockImportPlan> = {}): StockImportPlan => ({
  kind: 'count',
  total: 2,
  counts: { add: 1, update: 1, same: 0, blocked: 0 },
  blocked: [],
  sample: [
    { line: 2, site: 'NIC', date: '2026-10-10', code: 'RICE', name: 'Rice', qty: 3, old: null, action: 'add' },
    { line: 3, site: 'NIC', date: '2026-10-10', code: 'FLOUR', name: 'Flour', qty: 6, old: 5, action: 'update' },
  ],
  sites: ['NIC'],
  dates: ['2026-10-10'],
  hash: 'h'.repeat(64),
  alreadyImported: false,
  ...over,
});

async function choose(csv: string) {
  fireEvent.click(screen.getByText('Upload'));
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  const file = new File([csv], 'counts.csv', { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
}
const posts = (mode: string) => calls.filter((c) => c.method === 'POST' && c.url.includes(`mode=${mode}`));

describe('Stock upload dialog (D-73, slice 2c)', () => {
  it('reads the file, checks it with the server, shows what changes, and loads it with the hash it was given', async () => {
    onFetch((c) =>
      c.url.includes('mode=dry-run')
        ? { json: plan() }
        : c.url.includes('mode=commit')
          ? { json: { added: 1, updated: 1, same: 0 } }
          : undefined,
    );
    renderInShell(<StockScreen grid={grid()} />, 'chef');
    await choose('Code,Quantity\nrice,3\nflour,6\nsalt,\n');
    expect(await screen.findByText('Check the stock counts before loading')).toBeTruthy();
    // the file is sent as parsed rows: codes upper-cased, the screen's site and date filled in, the blank row skipped
    expect(posts('dry-run')[0]!.body).toMatchObject({
      kind: 'count',
      file: 'counts.csv',
      rows: [
        { site: 'NIC', date: '2026-10-10', code: 'RICE', qty: 3, line: 2 },
        { site: 'NIC', date: '2026-10-10', code: 'FLOUR', qty: 6, line: 3 },
      ],
    });
    expect(screen.getByText(/1 row has no quantity/)).toBeTruthy();
    expect(screen.getByText('What changes')).toBeTruthy();
    fireEvent.click(screen.getByText('Load 2 rows'));
    await waitFor(() => expect(posts('commit')).toHaveLength(1));
    expect(posts('commit')[0]!.body).toMatchObject({ kind: 'count', hash: 'h'.repeat(64) });
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });

  it('a file with rows the server blocks (or that cannot be read) cannot be loaded, and the reasons are listed', async () => {
    onFetch((c) =>
      c.url.includes('mode=dry-run')
        ? {
            json: plan({
              counts: { add: 1, update: 0, same: 0, blocked: 1 },
              blocked: [
                {
                  line: 4,
                  site: 'NIC',
                  date: '2026-10-10',
                  code: 'NOPE',
                  name: '',
                  qty: 1,
                  old: null,
                  action: 'blocked',
                  reason: 'not an ingredient you can use',
                },
              ],
            }),
          }
        : undefined,
    );
    renderInShell(<StockScreen grid={grid()} />, 'chef');
    await choose('Code,Quantity\nrice,3\nnope,1\nflour,lots\n');
    expect(await screen.findByText(/2 rows cannot be loaded/)).toBeTruthy(); // one from the sheet, one from the server
    expect(screen.getByText(/Row 4 NOPE: not an ingredient you can use/)).toBeTruthy();
    expect(screen.getByText(/Row 4 FLOUR: quantity "lots" is not a number/)).toBeTruthy();
    expect((screen.getByText(/^Load \d+ rows?$/) as HTMLButtonElement).disabled).toBe(true);
    expect(posts('commit')).toHaveLength(0);
  });

  it('a receipts file that was already loaded is refused with a plain message', async () => {
    onFetch((c) =>
      c.url.includes('mode=dry-run')
        ? { json: plan({ kind: 'receipt', alreadyImported: true, counts: { add: 2, update: 0, same: 0, blocked: 0 } }) }
        : undefined,
    );
    renderInShell(<StockScreen grid={grid('receipt')} />, 'chef');
    await choose('Code,Delivered\nrice,3\nflour,6\n');
    expect(await screen.findByText('This file has already been loaded.')).toBeTruthy();
    expect((screen.getByText(/^Load \d+ rows?$/) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a file with nothing usable says so instead of calling the server', async () => {
    renderInShell(<StockScreen grid={grid()} />, 'chef');
    await choose('Code,Quantity\nrice,\n');
    expect(await screen.findByText('No rows with a quantity were found.')).toBeTruthy();
    expect(posts('dry-run')).toHaveLength(0);
  });

  it('the template is the current grid with the site and date filled in; a viewer can take it but not upload', () => {
    renderInShell(<StockScreen grid={grid()} />, 'chef');
    fireEvent.click(screen.getByText('Template'));
    expect(saved.csv[0]).toEqual([
      ['Site', 'Date', 'Code', 'Item Name', 'Unit', 'Quantity'],
      ['NIC', '2026-10-10', 'FLOUR', 'Flour', 'Gram', 5],
      ['NIC', '2026-10-10', 'RICE', 'Rice', 'Gram', ''],
    ]);
    cleanup();
    renderInShell(<StockScreen grid={grid()} />, 'viewer');
    expect(screen.getByText('Template')).toBeTruthy();
    expect(screen.queryByText('Upload')).toBeNull();
  });
});
