// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls, detailFixture, installFetch, nav, onFetch, renderInShell, resetFetch } from './harness';

vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh }),
}));
vi.mock('@clerk/nextjs', () => ({ useClerk: () => ({ signOut: vi.fn() }) }));

import { EditScreen } from '@/components/recipes/EditScreen';
import { ItemsScreen } from '@/components/screens/ItemsScreen';
import { unitList } from './units-fixture';

beforeAll(() => {
  installFetch();
  window.scrollTo = vi.fn();
  vi.stubGlobal('print', vi.fn());
});
beforeEach(() => resetFetch());
afterEach(() => cleanup());

const brand = { id: 'b1', name: 'Gourmet', nameAr: null, color: '#BB5E1E', ink: null, logoUrl: null };
const brandList = [{ id: 'b1', name: 'Gourmet', code: 'GRM' }];
const item = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  code: 'ING-1',
  name: 'Chicken',
  uom: 'Gram' as const,
  price: 0.1,
  category: 'Meat',
  subcategory: 'Poultry',
  flag: '',
  version: 3,
  brandIds: [],
  conv: null,
  ...over,
});

describe('raw material default yields on the Items screen (D-93)', () => {
  it('shows the combined yield in a Yield column, blank when none is set', () => {
    renderInShell(
      <ItemsScreen
        items={[item({ yThaw: 0.9, yCut: 0.8 }), item({ id: 'i2', code: 'ING-2', name: 'Salt', yThaw: null })]}
        brands={brandList}
        priceDate="2026-10-09"
        units={unitList}
      />,
    );
    expect(screen.getByRole('columnheader', { name: 'Yield' })).toBeTruthy();
    const row = screen.getByText('ING-1').closest('tr')!;
    expect(within(row).getByText('72%')).toBeTruthy();
    expect(within(row).getByTitle('Thawing 90% · Cutting 80% · Cooking 100%')).toBeTruthy();
    expect(within(screen.getByText('ING-2').closest('tr')!).queryByText(/%/)).toBeNull();
  });

  it('the edit form saves the three stages as fractions; blank and 0 become null (100%)', async () => {
    const user = userEvent.setup();
    renderInShell(
      <ItemsScreen items={[item({ yCut: 0.5 })]} brands={brandList} priceDate="2026-10-09" units={unitList} />,
    );
    await user.click(within(screen.getByText('ING-1').closest('tr')!).getByRole('button', { name: 'Edit' }));
    const dlg = screen.getByRole('dialog');
    expect(within(dlg).getByDisplayValue('50')).toBeTruthy(); // cutting, shown as percent
    const [thaw, cut, cook] = within(dlg).getAllByPlaceholderText('100');
    await user.type(thaw!, '87.5');
    await user.clear(cut!);
    await user.type(cut!, '0');
    await user.type(cook!, '0'); // typed 0 = 100%
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({
      code: 'ING-1',
      version: 3,
      yThaw: 0.875,
      yCut: null,
      yCook: null,
    });
  });

  it('refuses a combination costing could not use, without sending anything', async () => {
    const user = userEvent.setup();
    renderInShell(<ItemsScreen items={[item()]} brands={brandList} priceDate="2026-10-09" units={unitList} />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dlg = screen.getByRole('dialog');
    const [thaw, cut] = within(dlg).getAllByPlaceholderText('100');
    await user.type(thaw!, '600');
    await user.type(cut!, '600');
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await screen.findByText('Each stage must be above 0%, and the three together up to 1000%');
    expect(calls).toHaveLength(0);
  });
});

describe('prefill and Save to raw material in the recipe editor (D-93, D-94)', () => {
  const picked = { code: 'ING-9', name: 'Fresh Chicken', uom: 'Gram', price: 0.01, sub: false };
  async function pick(extra: Record<string, unknown>) {
    onFetch((c) => {
      if (c.url.startsWith('/api/catalog/search')) return { json: { all: [{ ...picked, ...extra }], total: 1 } };
      if (c.method === 'PATCH') return { json: detailFixture({ version: 1 }) };
      return undefined;
    });
    const user = userEvent.setup();
    renderInShell(<EditScreen detail={detailFixture()} brand={brand} brands={brandList} />);
    const code = screen.getByDisplayValue('ING-1');
    await user.clear(code);
    await user.type(code, 'chicken');
    await user.click(await screen.findByText('Fresh Chicken', { selector: 'div' }));
    return user;
  }
  const lastPatchLine = () => {
    const p = [...calls].reverse().find((c) => c.method === 'PATCH');
    return (p!.body as { lines: Record<string, unknown>[] }).lines[0]!;
  };

  it('picking an ingredient with defaults fills only those stages and the line yield, and says so', async () => {
    await pick({ yThaw: 0.9, yCut: 0.8, yCook: null });
    expect((await screen.findAllByText(/yield 72%/)).length).toBeGreaterThan(0); // the toast and the Stages button
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(lastPatchLine()).toMatchObject({ code: 'ING-9', yThaw: 0.9, yCut: 0.8, yCook: null });
    expect(lastPatchLine().y).toBeCloseTo(0.72, 12);
  });

  it('an ingredient without defaults leaves the line yield alone', async () => {
    await pick({ yThaw: null, yCut: null, yCook: null });
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(lastPatchLine()).toMatchObject({ code: 'ING-9', y: 1, yThaw: null, yCut: null, yCook: null });
  });

  it('Save to raw material sends the dialog values for the line code; hidden without items.edit', async () => {
    onFetch((c) => (c.url === '/api/ingredients/yields' ? { json: { ok: true } } : undefined));
    const user = userEvent.setup();
    renderInShell(<EditScreen detail={detailFixture()} brand={brand} brands={brandList} />);
    await user.click(screen.getByRole('button', { name: 'Stages' }));
    const [thaw, , cook] = screen.getAllByPlaceholderText('100');
    await user.type(thaw!, '90');
    await user.type(cook!, '50');
    await user.click(screen.getByRole('button', { name: 'Save to raw material' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/ingredients/yields')).toBe(true));
    const c = calls.find((x) => x.url === '/api/ingredients/yields')!;
    expect(c.method).toBe('PUT');
    expect(c.body).toEqual({ code: 'ING-1', yThaw: 0.9, yCut: null, yCook: 0.5 });
    await screen.findByText('Yields saved to the raw material');
    expect(screen.getByText('Yield stages')).toBeTruthy(); // the dialog stays open
  });

  it('Save to raw material with every stage blank sends nothing', async () => {
    const user = userEvent.setup();
    renderInShell(<EditScreen detail={detailFixture()} brand={brand} brands={brandList} />);
    await user.click(screen.getByRole('button', { name: 'Stages' }));
    await user.click(screen.getByRole('button', { name: 'Save to raw material' }));
    await screen.findByText('Enter at least one stage to save to the raw material');
    expect(calls.some((c) => c.url === '/api/ingredients/yields')).toBe(false);
  });

  it('a role without items.edit does not get the button', async () => {
    const user = userEvent.setup();
    renderInShell(<EditScreen detail={detailFixture()} brand={brand} brands={brandList} />, 'chef');
    await user.click(screen.getByRole('button', { name: 'Stages' }));
    expect(screen.queryByRole('button', { name: 'Save to raw material' })).toBeNull();
  });
});
