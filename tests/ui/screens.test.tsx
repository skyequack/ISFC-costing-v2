// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls, cost, detailFixture, installFetch, nav, onFetch, renderInShell, resetFetch } from './harness';

vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh }),
}));
vi.mock('@clerk/nextjs', () => ({ useClerk: () => ({ signOut: vi.fn() }) }));

import { EditScreen } from '@/components/recipes/EditScreen';
import { ItemsScreen } from '@/components/screens/ItemsScreen';
import { RecipesScreen } from '@/components/screens/RecipesScreen';
import { ConvScreen } from '@/components/screens/ConvScreen';
import { SettingsScreen } from '@/components/screens/SettingsScreen';
import type { RecipeRow } from '@/lib/screens/rows';

beforeAll(() => {
  installFetch();
  // jsdom has no canvas / matchMedia / scrollTo
  window.scrollTo = vi.fn();
  vi.stubGlobal('print', vi.fn());
});
beforeEach(() => resetFetch());
afterEach(() => cleanup());

const brand = { id: 'b1', name: 'Gourmet', nameAr: null, color: '#BB5E1E', ink: null, logoUrl: null };
const brandList = [
  { id: 'b1', name: 'Gourmet', code: 'GRM' },
  { id: 'b2', name: 'Other', code: 'OTH' },
];

describe('recipe editor (legacy vEdit)', () => {
  it('commits a field on blur with the version, applies the returned cost view, and shows the optimistic value', async () => {
    const user = userEvent.setup();
    const d = detailFixture();
    onFetch((c) => {
      if (c.method === 'PATCH' && c.url === '/api/recipes/r1') {
        const nd = detailFixture({ name: 'Renamed', version: 1 });
        nd.view.cost = { ...cost, food: 20 };
        return { json: nd };
      }
    });
    renderInShell(<EditScreen detail={d} brand={brand} brands={brandList} />);
    const name = screen.getByDisplayValue('Beef Steak');
    await user.clear(name);
    await user.type(name, 'Renamed');
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0); // legacy onchange: nothing until blur
    await user.tab();
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ version: 0, name: 'Renamed' });
    await waitFor(() => expect(screen.getAllByText('20.000').length).toBeGreaterThan(0)); // food cost from the server's answer
  });

  it('sends the whole line list when a quantity changes; the second save carries the new version (serialised)', async () => {
    const user = userEvent.setup();
    let version = 0;
    onFetch((c) => {
      if (c.method === 'PATCH') {
        version += 1;
        return { json: detailFixture({ version }) };
      }
    });
    renderInShell(<EditScreen detail={detailFixture()} brand={brand} brands={brandList} />);
    const qty = screen.getByDisplayValue('100');
    await user.clear(qty);
    await user.type(qty, '250');
    await user.tab();
    const price = screen.getByDisplayValue('0');
    await user.clear(price);
    await user.type(price, '30');
    await user.tab();
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2));
    const [a, b] = calls.filter((c) => c.method === 'PATCH');
    expect(a!.body).toMatchObject({ version: 0, lines: [{ code: 'ING-1', qty: 250, unit: 'Gram', y: 1, yp: null }] });
    expect(b!.body).toEqual({ version: 1, sellingPrice: 30 });
  });

  it('read-only role: inputs are locked, no Lock / Delete behaviour needed; server messages surface as a toast and refresh on conflict', async () => {
    const user = userEvent.setup();
    onFetch((c) =>
      c.method === 'PATCH'
        ? {
            status: 409,
            json: { error: { code: 'conflict', message: 'This card was changed by someone else – reload it' } },
          }
        : undefined,
    );
    renderInShell(<EditScreen detail={detailFixture()} brand={brand} brands={brandList} />);
    const name = screen.getByDisplayValue('Beef Steak');
    await user.clear(name);
    await user.type(name, 'X');
    await user.tab();
    await screen.findByText(/changed by someone else/);
    expect(nav.refresh).toHaveBeenCalled();
    cleanup();
    renderInShell(<EditScreen detail={detailFixture()} brand={brand} brands={brandList} />, 'viewer');
    expect(screen.getByText(/Read only\./)).toBeTruthy();
    expect((screen.getByDisplayValue('Beef Steak') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('+ Add step').style.display).toBe('none'); // legacy enforce(): BUTTONs are hidden for a role without the permission
  });

  it('lock dialog: asks who approves; a blocked lock shows the problem and, for a GM, an override reason', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    onFetch((c) => {
      if (c.method === 'POST' && c.url === '/api/recipes/r1/lock') {
        attempt += 1;
        if (attempt === 1)
          return {
            status: 422,
            json: {
              error: {
                code: 'unprocessable',
                message: 'GRM-MN-0001 has 1 line problem(s) (missing price or unit conversion) and cannot be locked',
                details: { overridable: true, issues: [] },
              },
            },
          };
        return { json: { ok: true } };
      }
    });
    renderInShell(<EditScreen detail={detailFixture()} brand={brand} brands={brandList} />);
    await user.click(screen.getByRole('button', { name: /Lock & approve/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Lock and approve this card')).toBeTruthy();
    const approver = within(dialog).getByPlaceholderText('Your name') as HTMLInputElement;
    expect(approver.value).toBe('Tester');
    await user.click(within(dialog).getByRole('button', { name: /Lock & approve/ }));
    await within(dialog).findByText(/cannot be locked/);
    const reason = within(dialog).getByText(/Reason for locking despite the problems/);
    expect(reason).toBeTruthy();
    await user.type(within(dialog).getAllByRole('textbox')[1]!, 'price arrives Monday');
    await user.click(within(dialog).getByRole('button', { name: /Lock & approve/ }));
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/recipes/r1/lock')).toHaveLength(2));
    expect(calls.filter((c) => c.url === '/api/recipes/r1/lock')[1]!.body).toEqual({
      approvedBy: 'Tester',
      overrideReason: 'price arrives Monday',
    });
  });

  it('autocomplete: typing searches the picker; picking sets code and the library unit; a double-note (y != 1 with waste %) shows', async () => {
    const user = userEvent.setup();
    onFetch((c) => {
      if (c.url.startsWith('/api/catalog/search'))
        return { json: { all: [{ code: 'ING-9', name: 'Olive Oil', uom: 'Ml', price: 0.012, sub: false }], total: 1 } };
      if (c.method === 'PATCH') return { json: detailFixture({ version: 1 }) };
    });
    const d = detailFixture({ lines: [{ sortOrder: 0, code: 'ING-1', qty: 100, unit: 'Gram', y: 0.8, yp: 10 }] });
    renderInShell(<EditScreen detail={d} brand={brand} brands={brandList} />);
    expect(screen.getByText(/waste may be counted twice/)).toBeTruthy(); // D-45
    const code = screen.getByDisplayValue('ING-1');
    await user.clear(code);
    await user.type(code, 'oliv');
    const opt = await screen.findByText('Olive Oil');
    fireEvent.mouseDown(opt); // legacy used onmousedown so blur does not swallow the pick
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(
      (calls.find((c) => c.method === 'PATCH')!.body as { lines: { code: string; unit: string }[] }).lines[0],
    ).toMatchObject({ code: 'ING-9', unit: 'Ml' });
  });
});

const row = (i: number, over: Partial<RecipeRow> = {}): RecipeRow => ({
  id: `id${i}`,
  code: `GRM-MN-${String(i).padStart(4, '0')}`,
  name: `Dish ${i}`,
  cat: i % 2 ? 'Main Course' : 'Soup',
  type: 'menu',
  brandId: 'b1',
  status: 'DRAFT',
  nLines: 3,
  c: {
    batch: 5,
    err: '',
    out: 1,
    food: 5.75,
    totalCost: 5.75,
    net: 0,
    sp: 0,
    fcPct: null,
    npPct: null,
    bOut: 100,
    bUom: 'Gram',
    unitCost: null,
  },
  ...over,
});

describe('recipe list (legacy vRecipes)', () => {
  const rows = Array.from({ length: 120 }, (_, i) => row(i + 1, i === 4 ? { status: 'LOCKED' } : {}));
  it('pages 50 per page, filters in memory without a server call, category chips count, bulk delete asks first and is one all-or-nothing call', async () => {
    const user = userEvent.setup();
    onFetch((c) =>
      c.url === '/api/recipes/references'
        ? { json: { lines: 2, cards: ['Other dish'], codes: ['GRM-MN-0002'] } }
        : undefined,
    );
    renderInShell(<RecipesScreen rows={rows} brands={brandList} workspaceId="b1" target={0.3} />);
    expect(screen.getByText(/120 cards/)).toBeTruthy();
    expect(screen.getByText(/page 1 of 3/)).toBeTruthy();
    expect(screen.getAllByRole('row').length).toBe(51); // header + 50
    await user.type(screen.getByPlaceholderText(/Search name, code/), 'Dish 11');
    expect(screen.getByText(/11 cards/)).toBeTruthy(); // Dish 11, Dish 110..119
    expect(calls).toHaveLength(0); // typing never hits the server
    await user.click(screen.getByRole('button', { name: /Soup \(/ }));
    // select one row and delete it
    const boxes = screen.getAllByRole('checkbox');
    await user.click(boxes[1]!);
    expect(screen.getByText(/1 card selected/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));
    const dlg = screen.getByRole('dialog');
    await within(dlg).findByText(/Warning\./); // references warning from the server
    await user.click(within(dlg).getByRole('button', { name: /Delete card/ }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/recipes/bulk')).toBe(true));
    expect(calls.find((c) => c.url === '/api/recipes/bulk')!.body).toMatchObject({ action: 'delete' });
    await screen.findByText(/Deleted/);
    expect(screen.getByRole('button', { name: 'UNDO' })).toBeTruthy();
  });

  it('a role without recipe.delete is told so instead of getting a dialog', async () => {
    const user = userEvent.setup();
    renderInShell(<RecipesScreen rows={rows.slice(0, 5)} brands={brandList} workspaceId="b1" target={0.3} />, 'chef');
    await user.click(screen.getAllByRole('button', { name: 'Del' })[0]!);
    await screen.findByText(/Your role cannot do that/);
    expect(screen.queryByRole('dialog')?.className ?? '').not.toContain('on');
  });
});

describe('ingredients and conversions', () => {
  const items = [
    {
      id: 'i1',
      code: 'ING-1',
      name: 'Beef',
      uom: 'Gram' as const,
      price: 0.1,
      category: 'Meat',
      subcategory: 'Beef',
      flag: '',
      version: 3,
      brandIds: [],
      conv: null,
    },
    {
      id: 'i2',
      code: 'ING-2',
      name: 'Eggs',
      uom: 'Each' as const,
      price: null,
      category: 'Dairy',
      subcategory: 'Eggs',
      flag: 'PRICE MISSING',
      version: 0,
      brandIds: ['b1'],
      conv: { recipeUnit: 'Gram', factor: 60 },
    },
  ];
  it('item modal saves with the version; an empty price becomes null (never 0); negatives are refused client-side', async () => {
    const user = userEvent.setup();
    renderInShell(<ItemsScreen items={items} brands={brandList} priceDate="2026-10-09" />);
    const rowEl = screen.getByText('ING-2').closest('tr')!;
    await user.click(within(rowEl).getByRole('button', { name: 'Edit' }));
    const dlg = screen.getByRole('dialog');
    expect((within(dlg).getByDisplayValue('ING-2') as HTMLInputElement).readOnly).toBe(true);
    const price = within(dlg).getAllByRole('spinbutton')[0]!;
    await user.type(price, '-1');
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await screen.findByText('Price cannot be negative');
    expect(calls).toHaveLength(0);
    await user.clear(price);
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.url).toBe('/api/ingredients/i2');
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({
      code: 'ING-2',
      price: null,
      version: 0,
      brandIds: ['b1'],
    });
  });

  it('read-only role cannot see the edit buttons; the library filters by brand and category', async () => {
    const user = userEvent.setup();
    renderInShell(<ItemsScreen items={items} brands={brandList} priceDate="2026-10-09" />, 'viewer');
    expect(screen.getByText(/Read only\./)).toBeTruthy();
    for (const b of screen.getAllByText('Edit')) expect(b.style.display).toBe('none');
    await user.selectOptions(screen.getAllByRole('combobox')[0]!, 'b1');
    expect(screen.queryByText('ING-1')).toBeNull();
    expect(screen.getByText('ING-2')).toBeTruthy();
  });

  it('conversion editor previews the stored factor and refuses the same unit as the purchase unit', async () => {
    const user = userEvent.setup();
    renderInShell(<ConvScreen items={items} used={{ 'ING-2': 4 }} />);
    expect(screen.getByText(/1 Each = /)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '+ Add Conversion' }));
    const dlg = screen.getByRole('dialog');
    await user.type(within(dlg).getAllByRole('textbox')[0]!, 'ING-1');
    await within(dlg).findByText(/priced per Gram/);
    await user.selectOptions(within(dlg).getByRole('combobox'), 'Each');
    await user.type(within(dlg).getByRole('spinbutton'), '2');
    await within(dlg).findByText(/Stored as: 1 Gram = /);
    await user.selectOptions(within(dlg).getByRole('combobox'), 'Gram');
    await within(dlg).findByText(/already how this item is priced/);
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await screen.findByText(/no conversion needed/);
    expect(calls).toHaveLength(0);
  });
});

describe('settings (percent fields store fractions; brand logo box in the add-brand row, D-48)', () => {
  const settings = {
    currency: 'SAR',
    pkg: 0.1,
    del: 0.1,
    lab: 0.25,
    ops: 0.05,
    buffer: 0.15,
    target: 0.3,
    vat: 0.15,
    priceDate: '2026-10-09',
    version: 4,
  };
  const brands = [
    {
      id: 'b1',
      code: 'GRM',
      name: 'Gourmet',
      color: '#BB5E1E',
      logoUrl: null,
      locations: ['NIC'],
      cards: 0,
      locked: 0,
    },
  ];
  it('typing 12 in a percent field PATCHes 0.12 with the settings version', async () => {
    const user = userEvent.setup();
    onFetch((c) =>
      c.method === 'PATCH'
        ? { json: { settings: { ...settings, pkg: 0.12, version: 5 }, cards: 3, changed: ['pkg'] } }
        : undefined,
    );
    renderInShell(<SettingsScreen settings={settings} brands={brands} impact={[]} />);
    const pkg = screen.getAllByDisplayValue('10.00')[0]!;
    await user.clear(pkg);
    await user.type(pkg, '12');
    await user.tab();
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ version: 4, pkg: 0.12 });
  });
  it('the add-brand row carries a logo box; non-GM roles do not get the brand tools', () => {
    renderInShell(<SettingsScreen settings={settings} brands={brands} impact={[]} />);
    expect(screen.getByText('Brand logo')).toBeTruthy();
    expect(screen.getByText('Choose image')).toBeTruthy();
    expect(screen.getByText('No logo')).toBeTruthy();
    cleanup();
    renderInShell(<SettingsScreen settings={settings} brands={brands} impact={[]} />, 'cc');
    expect(screen.queryByText('Brand logo')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });
});
