// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls, installFetch, nav, onFetch, renderInShell, resetFetch } from './harness';

vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh }),
}));
vi.mock('@clerk/nextjs', () => ({ useClerk: () => ({ signOut: vi.fn() }) }));

const saved = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('@/components/io/download', async (orig) => {
  const actual = await orig<typeof import('@/components/io/download')>();
  return { ...actual, saveBlob: (name: string) => void saved.names.push(name) };
});

import { BackupScreen } from '@/components/screens/BackupScreen';

beforeAll(() => {
  installFetch();
  window.scrollTo = vi.fn();
});
beforeEach(() => {
  resetFetch();
  saved.names.length = 0;
});
afterEach(() => cleanup());

const counts = { items: 3, recipes: 2, conv: 1, photos: 0, photoKb: 0 };
const render = (role: Parameters<typeof renderInShell>[1], sites = ['NIC', 'NEOM']) =>
  renderInShell(<BackupScreen counts={counts} sites={sites} />, role);

describe('Backup & Export: Import templates card (D-86)', () => {
  it('lists the four templates, and the two old template buttons are no longer under Restore & Reset', () => {
    render('gm');
    const card = screen.getByText('Import templates').closest('.card') as HTMLElement;
    for (const t of [
      'Download a price list template',
      'Download a recipe template',
      'Download a stock counts template',
      'Download a stock receipts template',
    ])
      expect(card.textContent).toContain(t);
    const restore = screen.getByText('Restore & Reset').closest('.card') as HTMLElement;
    expect(restore.textContent).not.toContain('template');
    expect(restore.textContent).toContain('Upload a raw material price list');
  });

  it('shows each template only to the roles that can use the matching upload', () => {
    render('chef');
    expect(screen.getByText('Download a stock counts template')).toBeTruthy();
    expect(screen.getByText('Download a recipe template')).toBeTruthy();
    cleanup();
    render('viewer');
    expect(screen.getByText('Download a price list template')).toBeTruthy();
    // <Perm> hides what the role cannot use (display:none); the server enforces it either way
    for (const t of [
      'Download a stock counts template',
      'Download a stock receipts template',
      'Download a recipe template',
    ])
      expect(screen.queryByText(t)?.style.display ?? 'none').toBe('none');
  });

  it('downloads the counts template for the chosen site and day from the export endpoint', async () => {
    render('chef');
    fireEvent.click(screen.getByText('Download a stock counts template'));
    expect(screen.getByText('Stock counts template')).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('NIC'), { target: { value: 'NEOM' } });
    const date = document.querySelector('input[type=date]') as HTMLInputElement;
    fireEvent.change(date, { target: { value: '2026-10-09' } });
    fireEvent.click(screen.getByText('Download template'));
    await waitFor(() => expect(saved.names).toHaveLength(1));
    expect(calls.map((c) => c.url)).toContain('/api/export/stock-counts-template?loc=NEOM&date=2026-10-09');
  });

  it('the receipts template uses its own endpoint, and a failed download says so', async () => {
    render('cook');
    fireEvent.click(screen.getByText('Download a stock receipts template'));
    expect(screen.getByText('Stock receipts template')).toBeTruthy();
    onFetch((c) => (c.url.includes('stock-receipts-template') ? { status: 500, json: {} } : undefined));
    fireEvent.click(screen.getByText('Download template'));
    expect(await screen.findByText('Download failed')).toBeTruthy();
    expect(saved.names).toHaveLength(0);
    expect(calls.some((c) => c.url.startsWith('/api/export/stock-receipts-template?loc=NIC&date='))).toBe(true);
  });

  it('with no sites it says so and offers no download', () => {
    render('chef', []);
    fireEvent.click(screen.getByText('Download a stock counts template'));
    expect(screen.getByText('No sites yet.')).toBeTruthy();
    expect(screen.queryByText('Download template')).toBeNull();
  });
});
