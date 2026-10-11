// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nav, renderInShell, resetFetch, installFetch } from './harness';

vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh }),
}));
vi.mock('@clerk/nextjs', () => ({ useClerk: () => ({ signOut: vi.fn() }) }));

import { DashScreen } from '@/components/screens/DashScreen';
import type { DashData } from '@/lib/screens/dash';
import type { DashAnalytics } from '@/lib/services/dash';
import { DATE_COMMIT_MS } from '@/components/shared/DateField';

beforeAll(() => {
  installFetch();
  window.scrollTo = vi.fn();
});
beforeEach(() => resetFetch());
afterEach(() => cleanup());

const lastReplace = () => nav.replace.mock.calls.at(-1)?.[0];

const d: DashData = {
  target: 0.3,
  menus: 0,
  subs: 0,
  avgFC: null,
  priced: 0,
  excluded: 0,
  over: 0,
  loss: 0,
  locked: 0,
  total: 0,
  items: 5,
  flagged: 0,
  noPrice: 0,
  top: [],
  totalMenus: 0,
  byBrand: [],
  subRows: [],
};

const empty = (over: Partial<DashAnalytics> = {}): DashAnalytics => ({
  filters: { brand: '*', loc: '*', from: '', to: '' },
  sites: ['NIC', 'ZED'],
  brandOptions: [{ id: 'b1', name: 'Gourmet' }],
  ids: { 'A-1': 'r1' },
  portions: 0,
  producedCards: 0,
  matrix: {
    points: null,
    popularityCut: null,
    marginCut: null,
    classified: 2,
    unpriced: 1,
    noProduction: 0,
    unvalued: 0,
    totalPortions: 0,
  },
  risk: { rows: [], total: 0, count: 0 },
  overTarget: [],
  drivers: { rows: [], total: 0, count: 0 },
  unpriced: { rows: [], portions: 0, count: 0 },
  flags: { unconvertible: 0, truncated: 0, unknown: 0 },
  target: 0.3,
  currency: 'SAR',
  ...over,
});

describe('Dashboard filters and analytics (D-65…D-67)', () => {
  it('writes each filter to the URL; changing the brand resets the site; Reset appears only when filtered', () => {
    const a = empty({ filters: { brand: '*', loc: 'NIC', from: '', to: '' } });
    renderInShell(<DashScreen d={d} a={a} brandNames={{}} />);
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-10-01' } });
    fireEvent.blur(screen.getByLabelText('From date'));
    expect(lastReplace()).toBe('/dash?loc=NIC&from=2026-10-01');
    fireEvent.change(screen.getByDisplayValue('All brands'), { target: { value: 'b1' } });
    expect(lastReplace()).toBe('/dash?brand=b1'); // the site belonged to the old brand choice
    fireEvent.click(screen.getByText('Reset'));
    expect(lastReplace()).toBe('/dash');
    cleanup();
    renderInShell(<DashScreen d={d} a={empty()} brandNames={{}} />);
    expect(screen.queryByText('Reset')).toBeNull();
    expect(screen.queryByText(/^Filtered:/)).toBeNull();
  });

  describe('typing a date', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const from = () => screen.getByLabelText('From date') as HTMLInputElement;
    const withFrom = (v: string) =>
      renderInShell(
        <DashScreen d={d} a={empty({ filters: { brand: '*', loc: '*', from: v, to: '' } })} brandNames={{}} />,
      );

    it('keeps what is typed, ignores intermediate years, and applies the final date once after a pause', () => {
      renderInShell(<DashScreen d={d} a={empty()} brandNames={{}} />);
      for (const v of ['0002-10-01', '0020-10-01', '0202-10-01']) {
        fireEvent.change(from(), { target: { value: v } });
        expect(from().value).toBe(v); // the field does not snap back while the user is typing
        vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
        expect(nav.replace).not.toHaveBeenCalled(); // a year before 1900 is never applied
      }
      fireEvent.change(from(), { target: { value: '2026-10-01' } });
      expect(nav.replace).not.toHaveBeenCalled(); // not before the pause
      vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
      expect(nav.replace).toHaveBeenCalledTimes(1);
      expect(lastReplace()).toBe('/dash?from=2026-10-01');
    });

    it('applies at once on Enter or when leaving the field, and clearing the field removes the filter', () => {
      withFrom('2026-10-01');
      fireEvent.change(from(), { target: { value: '2026-11-02' } });
      fireEvent.keyDown(from(), { key: 'Enter' });
      expect(lastReplace()).toBe('/dash?from=2026-11-02');
      nav.replace.mockClear();
      vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
      expect(nav.replace).not.toHaveBeenCalled(); // the pending timer was cancelled by the commit
      fireEvent.change(from(), { target: { value: '' } });
      fireEvent.blur(from());
      expect(lastReplace()).toBe('/dash');
    });

    it('does not apply an unchanged value again', () => {
      withFrom('2026-10-01');
      fireEvent.blur(from());
      expect(nav.replace).not.toHaveBeenCalled();
    });
  });

  it('says which sections respond to which filter, and shows an invalid-filter message', () => {
    const a = empty({ filters: { brand: 'b1', loc: 'NIC', from: '2026-10-01', to: '2026-10-31' } });
    renderInShell(<DashScreen d={d} a={a} filterError="not a calendar date" brandNames={{}} />);
    expect(screen.getByText(/Filtered: Gourmet/).textContent).toMatch(/Site and dates apply to the Menu Matrix/);
    expect(screen.getByText('not a calendar date')).toBeTruthy();
  });

  it('exports with exactly the filters on screen', () => {
    const a = empty({ filters: { brand: 'b1', loc: 'NIC', from: '2026-10-01', to: '2026-10-31' } });
    const original = window.location;
    const loc = { href: '' };
    vi.stubGlobal('location', loc);
    try {
      renderInShell(<DashScreen d={d} a={a} brandNames={{}} />);
      fireEvent.click(screen.getByText('Export analytics'));
      expect(loc.href).toBe('/api/export/dash?brand=b1&loc=NIC&from=2026-10-01&to=2026-10-31');
    } finally {
      vi.stubGlobal('location', original); // do not leak the fake into the tests that follow
    }
  });

  it('the matrix: not-enough-data state, then classes with clickable chips that open the card', () => {
    renderInShell(<DashScreen d={d} a={empty()} brandNames={{}} />);
    expect(screen.getByText('Not enough data to classify yet')).toBeTruthy();
    expect(screen.getByText(/Not classified: 1 with production but no selling price/)).toBeTruthy();
    cleanup();
    const pts = [
      { code: 'A-1', name: 'Alpha', portions: 100, share: 0.5, contribution: 9, quadrant: 'star' as const },
      { code: 'B-1', name: 'Beta', portions: 50, share: 0.25, contribution: 1, quadrant: 'plowhorse' as const },
      { code: 'C-1', name: 'Gamma', portions: 20, share: 0.1, contribution: 8, quadrant: 'puzzle' as const },
      { code: 'D-1', name: 'Delta', portions: 10, share: 0.05, contribution: 1, quadrant: 'dog' as const },
    ];
    const a = empty({
      portions: 180,
      ids: { 'A-1': 'r1', 'B-1': 'r2', 'C-1': 'r3', 'D-1': 'r4' },
      matrix: {
        points: pts,
        popularityCut: 31.5,
        marginCut: 5,
        classified: 4,
        unpriced: 0,
        noProduction: 0,
        unvalued: 0,
        totalPortions: 180,
      },
    });
    renderInShell(<DashScreen d={d} a={a} brandNames={{}} />);
    for (const t of ['Stars', 'Plowhorses', 'Puzzles', 'Dogs']) expect(screen.getByText(t)).toBeTruthy();
    fireEvent.click(screen.getAllByText('A-1')[0]!);
    expect(nav.push.mock.calls[0]?.[0]).toBe('/edit/r1');
  });
});
