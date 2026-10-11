// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls, detailFixture, installFetch, nav, onFetch, renderInShell, resetFetch } from './harness';

vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh }),
}));
vi.mock('@clerk/nextjs', () => ({ useClerk: () => ({ signOut: vi.fn() }) }));

import { EditScreen } from '@/components/recipes/EditScreen';

beforeAll(() => {
  installFetch();
  window.scrollTo = vi.fn();
  vi.stubGlobal('print', vi.fn());
});
beforeEach(() => resetFetch());
afterEach(() => cleanup());

const brand = { id: 'b1', name: 'Gourmet', nameAr: null, color: '#BB5E1E', ink: null, logoUrl: null };
const brandList = [{ id: 'b1', name: 'Gourmet', code: 'GRM' }];
const line = (over: Record<string, unknown> = {}) => ({
  sortOrder: 0,
  code: 'ING-1',
  qty: 100,
  unit: 'Gram',
  y: 1,
  yp: null,
  yThaw: null,
  yCut: null,
  yCook: null,
  ...over,
});
const patches = () => calls.filter((c) => c.method === 'PATCH');

describe('line yield stages (D-70, D-85)', () => {
  it('Stages opens a dialog: three percentages, the combined yield live, saved as fractions with their product', async () => {
    onFetch((c) => (c.method === 'PATCH' ? { json: detailFixture({ version: 1 }) } : undefined));
    const user = userEvent.setup();
    renderInShell(<EditScreen detail={detailFixture({ lines: [line()] })} brand={brand} brands={brandList} />);
    await user.click(screen.getByRole('button', { name: 'Stages' }));
    expect(screen.getByText('Yield stages')).toBeTruthy();
    const [thaw, cut, cook] = screen.getAllByPlaceholderText('100');
    await user.type(thaw!, '90');
    await user.type(cut!, '80');
    expect(screen.getByText('72%')).toBeTruthy(); // a blank stage counts as 100%
    await user.type(cook!, '50');
    expect(screen.getByText('36%')).toBeTruthy();
    expect(screen.queryByText('Clear stages')).toBeNull(); // nothing to clear yet
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    const l = (patches()[0]!.body as { lines: Record<string, unknown>[] }).lines[0]!;
    expect(l).toMatchObject({ code: 'ING-1', yThaw: 0.9, yCut: 0.8, yCook: 0.5 });
    expect(l.y).toBeCloseTo(0.36, 12);
  });

  it('a staged line shows its combined yield; Clear stages removes the stages and keeps that yield as the line own', async () => {
    onFetch((c) => (c.method === 'PATCH' ? { json: detailFixture({ version: 1 }) } : undefined));
    const user = userEvent.setup();
    const detail = detailFixture({ lines: [line({ y: 0.72, yThaw: 0.9, yCut: 0.8 })] });
    renderInShell(<EditScreen detail={detail} brand={brand} brands={brandList} />);
    await user.click(screen.getByRole('button', { name: 'yield 72%' }));
    expect(screen.getByDisplayValue('90')).toBeTruthy();
    expect(screen.getByDisplayValue('80')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear stages' }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect((patches()[0]!.body as { lines: Record<string, unknown>[] }).lines[0]).toMatchObject({
      y: 0.72,
      yThaw: null,
      yCut: null,
      yCook: null,
    });
  });

  it('refuses values outside the range without sending anything', async () => {
    const user = userEvent.setup();
    renderInShell(<EditScreen detail={detailFixture({ lines: [line()] })} brand={brand} brands={brandList} />);
    await user.click(screen.getByRole('button', { name: 'Stages' }));
    const [thaw, cut] = screen.getAllByPlaceholderText('100');
    await user.type(thaw!, '600');
    await user.type(cut!, '600'); // 6 x 6 = 36 > 10
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Yield stages')).toBeTruthy(); // still open
    expect(patches()).toHaveLength(0);
  });

  it('a role that cannot edit sees the combined yield as a badge and no button', () => {
    const detail = detailFixture({ lines: [line({ y: 0.72, yThaw: 0.9, yCut: 0.8 })] });
    renderInShell(<EditScreen detail={detail} brand={brand} brands={brandList} />, 'viewer');
    expect(screen.queryByRole('button', { name: /yield 72%|Stages/ })).toBeNull();
    expect(screen.getByText('yield 72%')).toBeTruthy();
  });
});
