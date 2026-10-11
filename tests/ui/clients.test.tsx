// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls, installFetch, nav, onFetch, renderInShell, resetFetch } from './harness';

vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh }),
}));
vi.mock('@clerk/nextjs', () => ({ useClerk: () => ({ signOut: vi.fn() }) }));

import { ClientsCard, type SettingsClient } from '@/components/screens/ClientsCard';
import { ProdScreen } from '@/components/screens/ProdScreen';
import type { ProdData } from '@/lib/screens/prod';

beforeAll(() => {
  installFetch();
  window.scrollTo = vi.fn();
});
beforeEach(() => resetFetch());
afterEach(() => cleanup());

const brands = [
  { id: 'b1', name: 'Gourmet' },
  { id: 'b2', name: 'Other' },
];
const clients: SettingsClient[] = [
  { id: 'c1', brandId: 'b1', brandName: 'Gourmet', name: 'Acme', active: true, version: 3 },
  { id: 'c2', brandId: 'b1', brandName: 'Gourmet', name: 'Old Co', active: false, version: 0 },
];

describe('Clients card in Cost Settings (D-68/D-71)', () => {
  it('adds a client to the chosen brand', async () => {
    renderInShell(<ClientsCard clients={clients} brands={brands} />, 'cc');
    fireEvent.change(screen.getByDisplayValue('Gourmet'), { target: { value: 'b2' } });
    fireEvent.change(screen.getByPlaceholderText('Client name'), { target: { value: '  Beta  ' } });
    fireEvent.click(screen.getByText('Add client'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/brands/b2/clients');
    expect(post.body).toEqual({ name: 'Beta' });
  });

  it('renames on blur, (de)activates and removes, always sending the version it read', async () => {
    renderInShell(<ClientsCard clients={clients} brands={brands} />, 'gm');
    const name = screen.getByDisplayValue('Acme');
    fireEvent.change(name, { target: { value: 'Acme Ltd' } });
    fireEvent.blur(name);
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
      url: '/api/clients/c1',
      body: { name: 'Acme Ltd', version: 3 },
    });
    fireEvent.click(screen.getByText('Deactivate'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'PATCH')[1]).toMatchObject({ body: { active: false, version: 3 } });
    fireEvent.click(screen.getByText('Reactivate'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(3));
    expect(calls.filter((c) => c.method === 'PATCH')[2]).toMatchObject({
      url: '/api/clients/c2',
      body: { active: true, version: 0 },
    });
    fireEvent.click(screen.getAllByText('Remove')[0]!);
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('a rename that changes nothing sends nothing, and a blank name is refused and put back', async () => {
    renderInShell(<ClientsCard clients={clients} brands={brands} />, 'cc');
    const name = screen.getByDisplayValue('Acme') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Acme  ' } });
    fireEvent.blur(name);
    const nameField = () =>
      screen.getAllByRole('textbox').find((i) => (i as HTMLInputElement).value.trim() === 'Acme') as HTMLInputElement;
    expect(nameField().value).toBe('Acme'); // the unchanged edit was dropped and the field put back
    fireEvent.change(nameField(), { target: { value: '   ' } });
    fireEvent.blur(screen.getAllByRole('textbox').find((i) => (i as HTMLInputElement).value === '   ')!);
    expect(await screen.findByText('A client needs a name')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    expect(nameField().value).toBe('Acme');
  });

  it('a client with production cannot be removed: the server message is shown', async () => {
    onFetch((c) =>
      c.method === 'DELETE'
        ? {
            status: 409,
            json: { error: { code: 'conflict', message: 'Acme has 3 production rows - deactivate it instead' } },
          }
        : undefined,
    );
    renderInShell(<ClientsCard clients={clients} brands={brands} />, 'cc');
    fireEvent.click(screen.getAllByText('Remove')[0]!);
    expect(await screen.findByText(/deactivate it instead/)).toBeTruthy();
  });

  it('roles without clients.edit see the list but no controls', () => {
    for (const role of ['chef', 'cook', 'fin', 'viewer'] as const) {
      renderInShell(<ClientsCard clients={clients} brands={brands} />, role);
      expect(screen.getByText('Acme')).toBeTruthy();
      expect(screen.queryByText('Add client')).toBeNull();
      expect(screen.queryByText('Deactivate')?.style.display ?? 'none').toBe('none');
      cleanup();
    }
  });
});

const prodData = (over: Partial<ProdData['params']> = {}, locked = false, choices = true): ProdData =>
  ({
    params: { view: 'day', month: '2097-06', day: '09', brand: 'b1', loc: '*', client: '*', ...over },
    nd: 30,
    locs: [],
    brandOptions: brands,
    clientChoices: choices
      ? [
          { id: 'c1', name: 'Acme', active: true },
          { id: 'c2', name: 'Old Co', active: false },
        ]
      : [],
    brandName: 'Gourmet',
    nCards: 1,
    currency: 'SAR',
    weekday: 'TUESDAY',
    sections: [
      {
        key: 'main',
        en: 'Main',
        ar: '',
        total: 0,
        cards: [{ code: 'GRM-1', name: 'Beef', brandCode: 'GRM', food: 2, qty: 5, value: 10, locked }],
      },
    ],
    totals: { total: 10, portions: 5, secCount: 1 },
    builder: null,
    draw: { rows: [], value: 0 },
    req: { rows: [], total: 0, dishes: 0, nSections: 0, sections: [], flags: [], reconciliation: [] },
    monthRows: [],
    monthTotals: { sec: {}, portions: 0, total: 0 },
    secLabels: [],
  }) as unknown as ProdData;

describe('Production screen Client field (D-71)', () => {
  it('the Client select appears with a client choice, and picking one goes in the URL', () => {
    renderInShell(<ProdScreen data={prodData()} />, 'gm', 'b1');
    const select = screen.getByDisplayValue('All clients') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'All clients',
      'Unassigned',
      'Acme',
      'Old Co (inactive)', // an inactive client stays listed so its rows can be corrected
    ]);
    fireEvent.change(select, { target: { value: 'c1' } });
    expect(String(nav.replace.mock.calls.at(-1)?.[0])).toContain('c=c1');
  });

  it('is hidden when the brand has no clients, and changing the brand goes back to all clients', () => {
    renderInShell(<ProdScreen data={prodData({}, false, false)} />, 'gm', 'b1');
    expect(screen.queryByText('Unassigned')).toBeNull();
    fireEvent.change(screen.getByDisplayValue('Gourmet'), { target: { value: 'b2' } });
    const url = String(nav.replace.mock.calls.at(-1)?.[0]);
    expect(url).toContain('b=b2');
    expect(url).toContain('c=*');
  });

  it('under "All clients" a card of a brand with clients is read-only with a note; with a client picked a number is saved for that client', async () => {
    renderInShell(<ProdScreen data={prodData({ client: '*' }, true)} />, 'gm', 'b1');
    expect(screen.getByText(/Every client is added together here/)).toBeTruthy();
    expect(screen.queryByPlaceholderText('0')).toBeNull();
    cleanup();
    renderInShell(<ProdScreen data={prodData({ client: 'c1' }, false)} />, 'gm', 'b1');
    const cell = screen.getByPlaceholderText('0');
    fireEvent.change(cell, { target: { value: '9' } });
    fireEvent.blur(cell);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: '/api/production',
      body: { recipeCode: 'GRM-1', clientId: 'c1', portions: 9 },
    });
  });

  it('with Unassigned picked (or a brand with no clients) the number is saved as unassigned', async () => {
    renderInShell(<ProdScreen data={prodData({ client: 'none' }, false)} />, 'gm', 'b1');
    const cell = screen.getByPlaceholderText('0');
    fireEvent.change(cell, { target: { value: '4' } });
    fireEvent.blur(cell);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ clientId: '', portions: 4 });
  });
});
