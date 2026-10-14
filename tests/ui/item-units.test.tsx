// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls, installFetch, nav, renderInShell, resetFetch } from './harness';

vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh }),
}));
vi.mock('@clerk/nextjs', () => ({ useClerk: () => ({ signOut: vi.fn() }) }));

import { ItemsScreen } from '@/components/screens/ItemsScreen';
import { unitList } from './units-fixture';

beforeAll(() => {
  installFetch();
  window.scrollTo = vi.fn();
  vi.stubGlobal('print', vi.fn());
});
beforeEach(() => resetFetch());
afterEach(() => cleanup());

const brandList = [{ id: 'b1', name: 'Gourmet', code: 'GRM' }];
const item = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  code: 'ING-1',
  name: 'Tomato tins',
  uom: 'Gram' as const,
  price: 0.008,
  category: 'Dry',
  subcategory: 'Tins',
  flag: '',
  version: 3,
  brandIds: [],
  conv: null,
  purchaseUnit: 'Gram',
  purchaseFactor: 1,
  inventoryUnit: 'Gram',
  inventoryFactor: 1,
  ...over,
});
const screenOf = (items: ReturnType<typeof item>[], role = 'gm') =>
  renderInShell(<ItemsScreen items={items} brands={brandList} priceDate="2026-10-09" units={unitList} />, role as 'gm');

describe('three units on the Items screen (D-102)', () => {
  it('shows a Buy as column only for an item bought in another unit', () => {
    screenOf([
      item({ purchaseUnit: 'Carton', purchaseFactor: 12000 }),
      item({ id: 'i2', code: 'ING-2', name: 'Salt' }),
    ]);
    expect(screen.getByRole('columnheader', { name: 'Buy as' })).toBeTruthy();
    expect(within(screen.getByText('ING-1').closest('tr')!).getByText('Carton · 12000')).toBeTruthy();
    expect(within(screen.getByText('ING-2').closest('tr')!).queryByText(/·/)).toBeNull();
  });

  it('a pack unit asks for its factor and sends both; a fixed unit sends its own factor', async () => {
    const user = userEvent.setup();
    screenOf([item()]);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dlg = screen.getByRole('dialog');
    await user.selectOptions(within(dlg).getByLabelText('Purchase unit'), 'Carton');
    await user.type(within(dlg).getByLabelText('1 Carton = ? Gram'), '12000');
    await user.selectOptions(within(dlg).getByLabelText('Inventory unit'), 'Kg');
    expect(within(dlg).getByText('1 Kg = 1000 Gram')).toBeTruthy();
    expect(within(dlg).getByLabelText('Price per Carton')).toHaveProperty('value', '96'); // 0.008 per Gram x 12000
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({
      purchaseUnit: 'Carton',
      purchaseFactor: 12000,
      inventoryUnit: 'Kg',
      inventoryFactor: 1000,
    });
  });

  it('typing the pack price fills the price per base unit with the exact quotient; typing the price again takes over', async () => {
    const user = userEvent.setup();
    screenOf([item({ price: null })]);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dlg = screen.getByRole('dialog');
    expect(within(dlg).queryByLabelText('Price per Carton')).toBeNull(); // nothing to derive from while the unit is the base unit
    await user.selectOptions(within(dlg).getByLabelText('Purchase unit'), 'Carton');
    await user.type(within(dlg).getByLabelText('1 Carton = ? Gram'), '12000');
    await user.type(within(dlg).getByLabelText('Price per Carton'), '96');
    expect(within(dlg).getByDisplayValue('0.008')).toBeTruthy();
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ price: 96 / 12000, purchaseFactor: 12000 });
    expect(96 / 12000).toBe(0.008);
  });

  it('refuses a unit that does not fit the base unit, and a pack unit with no factor, without sending anything', async () => {
    const user = userEvent.setup();
    screenOf([item()]);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const dlg = screen.getByRole('dialog');
    await user.selectOptions(within(dlg).getByLabelText('Purchase unit'), 'L');
    expect(within(dlg).getByText('L cannot be used for an item counted in Gram')).toBeTruthy();
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await screen.findAllByText('L cannot be used for an item counted in Gram');
    await user.selectOptions(within(dlg).getByLabelText('Purchase unit'), 'Bag');
    await user.click(within(dlg).getByRole('button', { name: 'Save' }));
    await screen.findByText('Enter how many Gram one Bag holds, as a number above zero');
    expect(calls).toHaveLength(0);
  });

  it('shows the cooking unit from Conv, read only', async () => {
    const user = userEvent.setup();
    screenOf([item({ conv: { recipeUnit: 'Kg', factor: 0.001 } })]);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(
      within(screen.getByRole('dialog')).getByText(/Cooking unit: Kg \(1 Gram = 0.001 Kg\), set on Conv/),
    ).toBeTruthy();
  });

  it('only the GM sees the Units button', () => {
    screenOf([item()], 'cc');
    expect(screen.queryByRole('button', { name: 'Units' })).toBeNull();
    cleanup();
    screenOf([item()], 'gm');
    expect(screen.getByRole('button', { name: 'Units' })).toBeTruthy();
  });
});
