// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls, cost, detailFixture, installFetch, nav, onFetch, renderInShell, resetFetch } from './harness';

const saved = vi.hoisted(() => ({ xlsx: [] as string[] }));
vi.mock('@/components/io/download', async (orig) => {
  const actual = await orig<typeof import('@/components/io/download')>();
  return { ...actual, saveXlsx: (name: string) => void saved.xlsx.push(name) };
});
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
    expect(a!.body).toMatchObject({
      version: 0,
      lines: [{ code: 'ING-1', qty: 250, unit: 'Gram', y: 1, yp: null, yThaw: null, yCut: null, yCook: null }],
    });
    expect(b!.body).toEqual({ version: 1, sellingPrice: 30 });
  });

  it('two line edits in the same tick (quantity blur + unit change) both reach the server', async () => {
    let version = 0;
    onFetch((c) => (c.method === 'PATCH' ? { json: detailFixture({ version: ++version }) } : undefined));
    renderInShell(<EditScreen detail={detailFixture()} brand={brand} brands={brandList} />);
    const qty = screen.getByDisplayValue('100');
    const unit = screen.getAllByDisplayValue('Gram').find((e) => e.tagName === 'SELECT' && e.closest('table'))!;
    // one batched event burst, as a fast keyboard/automation produces: no render between the two handlers
    const { act } = await import('@testing-library/react');
    act(() => {
      fireEvent.focus(qty);
      fireEvent.change(qty, { target: { value: '500' } });
      fireEvent.blur(qty);
      fireEvent.change(unit, { target: { value: 'Ml' } });
    });
    // both edits are in the SAME request now (coalesced), and neither is lost
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1));
    expect(calls.filter((c) => c.method === 'PATCH')[0]!.body).toMatchObject({
      version: 0,
      lines: [{ code: 'ING-1', qty: 500, unit: 'Ml' }],
    });
  });

  it('edits made while a save is in flight become ONE follow-up request with the newest version; a price edit is never merged', async () => {
    let release: (() => void) | undefined;
    let version = 0;
    const gate = new Promise<void>((r) => (release = r));
    const real = globalThis.fetch;
    let first = true;
    vi.stubGlobal('fetch', async (u: string, i?: RequestInit) => {
      if (i?.method === 'PATCH' && first) {
        first = false;
        calls.push({ method: 'PATCH', url: u, body: JSON.parse(String(i.body)) });
        await gate; // the first save stays in flight while the user keeps editing
        return new Response(JSON.stringify(detailFixture({ version: ++version })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return real(u, i);
    });
    onFetch((c) => (c.method === 'PATCH' ? { json: detailFixture({ version: ++version }) } : undefined));
    const user = userEvent.setup();
    renderInShell(<EditScreen detail={detailFixture()} brand={brand} brands={brandList} />);
    const name = screen.getByDisplayValue('Beef Steak');
    await user.clear(name);
    await user.type(name, 'A');
    await user.tab(); // save 1 goes out and is held
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1));
    const cat = screen.getByDisplayValue('Main Course');
    await user.clear(cat);
    await user.type(cat, 'Grill');
    await user.tab(); // queued
    const qty = screen.getByDisplayValue('100');
    await user.clear(qty);
    await user.type(qty, '250');
    await user.tab(); // merged into the same queued request
    const price = screen.getByDisplayValue('0');
    await user.clear(price);
    await user.type(price, '30');
    await user.tab(); // price: its own request
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1); // nothing else sent while one is in flight
    release!();
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(3));
    const [a, b, p] = calls.filter((c) => c.method === 'PATCH');
    expect(a!.body).toEqual({ version: 0, name: 'A' });
    expect(b!.body).toEqual({
      version: 1,
      category: 'Grill',
      lines: [{ code: 'ING-1', qty: 250, unit: 'Gram', y: 1, yp: null, yThaw: null, yCut: null, yCook: null }],
    });
    expect(p!.body).toEqual({ version: 2, sellingPrice: 30 });
    vi.stubGlobal('fetch', real);
  });

  it('a picked ingredient shows its name, unit and price at once, not "unknown code"', async () => {
    const user = userEvent.setup();
    const hold = new Promise(() => {});
    onFetch((c) => {
      if (c.url.startsWith('/api/catalog/search'))
        return {
          json: {
            all: [{ code: 'ING-9', name: 'Fresh Chicken Whole', uom: 'Gram', price: 0.01373, sub: false }],
            total: 1,
          },
        };
      return undefined;
    });
    // the PATCH never answers, so only what the picker already knew can be on screen
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (u: string, i?: RequestInit) =>
      i?.method === 'PATCH' ? (hold as Promise<Response>) : realFetch(u, i),
    );
    renderInShell(<EditScreen detail={detailFixture()} brand={brand} brands={brandList} />);
    const code = screen.getByDisplayValue('ING-1');
    await user.clear(code);
    await user.type(code, 'chicken');
    await user.click(await screen.findByText('Fresh Chicken Whole', { selector: 'div' }));
    expect(await screen.findAllByText('Fresh Chicken Whole')).not.toHaveLength(0);
    expect(screen.queryByText('unknown code')).toBeNull();
    expect(screen.getByText('0.013730')).toBeTruthy();
    vi.stubGlobal('fetch', realFetch);
  });

  it('adding lines while the save is still in flight does not crash the editor (print layer built from costed lines only)', async () => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (u: string, i?: RequestInit) =>
      i?.method === 'PATCH' ? new Promise<Response>(() => {}) : real(u, i),
    );
    const user = userEvent.setup();
    renderInShell(<EditScreen detail={detailFixture()} brand={brand} brands={brandList} />);
    const inputs = () => screen.getAllByPlaceholderText('type a name or code');
    expect(inputs()).toHaveLength(1);
    await user.click(screen.getByText('Add blank row'));
    await user.click(screen.getByText('Add blank row'));
    expect(inputs()).toHaveLength(3); // optimistic rows are there and nothing threw
    vi.stubGlobal('fetch', real);
  });

  it('toPrintCard skips lines the server has not costed yet (a coded line added while a save is in flight)', async () => {
    const { toPrintCard } = await import('@/components/recipes/print');
    const d = detailFixture();
    d.recipe.lines = [
      ...d.recipe.lines,
      { sortOrder: 1, code: 'ING-NEW', qty: 5, unit: 'Gram', y: 1, yp: null }, // optimistic: no view line yet
    ];
    expect(() => toPrintCard(d, null)).not.toThrow();
    expect(toPrintCard(d, null).lines.map((l) => l.code)).toEqual(['ING-1']);
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
  stockClass: null,
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

describe('Revisions (D-100)', () => {
  const list = (cur: number) => ({
    revisions: [
      {
        revision: cur,
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        status: 'DRAFT',
        name: 'Beef Steak',
        lockedBy: null,
        createdBy: null,
        origin: null,
        nLines: 1,
      },
      {
        revision: cur - 1,
        effectiveFrom: '2025-12-01',
        effectiveTo: '2026-01-01',
        status: 'LOCKED',
        name: 'Beef Steak',
        lockedBy: 'Chef',
        createdBy: 'T gm',
        origin: 'BUTTON',
        nLines: 2,
      },
    ],
  });

  it('lists the revisions, shows an earlier one read-only, and Start new revision asks first, then POSTs the card version', async () => {
    const user = userEvent.setup();
    onFetch((c) => {
      if (c.url === '/api/recipes/r1/revisions' && c.method === 'GET') return { json: list(2) };
      if (c.url === '/api/recipes/r1/revisions/1')
        return {
          json: {
            ...list(2).revisions[1],
            lines: [{ sortOrder: 0, code: 'ING-OLD', qty: 12, unit: 'Gram', y: 1, yp: null }],
            method: ['Old step'],
          },
        };
      if (c.url === '/api/recipes/r1/revisions' && c.method === 'POST')
        return { json: { revision: 3, effectiveFrom: '2026-10-13', version: 1 } };
      return undefined;
    });
    renderInShell(<EditScreen detail={detailFixture()} brand={brand} brands={brandList} />);
    expect(await screen.findByText(/In force since 2026-01-01/)).toBeTruthy();
    expect(await screen.findByText('Locked')).toBeTruthy(); // the earlier revision's status
    await user.click(screen.getByRole('button', { name: 'View' }));
    expect(await screen.findByText('ING-OLD')).toBeTruthy();
    expect(screen.getByText('Old step')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    // nothing is sent until the confirmation
    await user.click(screen.getAllByRole('button', { name: 'Start new revision' })[0]!);
    expect(screen.getByText(/Freezes this card as revision 1 and starts revision 2 today/)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    const dialog = screen.getAllByRole('button', { name: 'Start new revision' });
    await user.click(dialog[dialog.length - 1]!);
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/recipes/r1/revisions')).toBe(true),
    );
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ version: 0 });
    expect(await screen.findByText('Revision 3 started')).toBeTruthy();
  });

  it('a revision that started today cannot be started again: the button is replaced by the explanation', async () => {
    onFetch((c) => (c.url === '/api/recipes/r1/revisions' ? { json: list(1) } : undefined));
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
    renderInShell(<EditScreen detail={detailFixture({ effectiveFrom: today })} brand={brand} brands={brandList} />);
    expect(await screen.findByText(/A revision already started today. Keep editing it./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start new revision' })).toBeNull();
  });
});

describe('Upload: a card whose code exists asks what to do (D-101)', () => {
  const planFor = (cards: { code: string; name: string; mode?: string }[]) => ({
    cards: cards.map((c, i) => ({
      index: i,
      code: c.code || 'GRM-MN-0001',
      name: c.name,
      type: 'MENU',
      brandId: 'b1',
      brandName: 'Gourmet',
      brandCode: 'GRM',
      action: c.mode === 'update' ? 'update' : c.mode === 'new' ? 'add' : 'exists',
      targetId: c.mode === 'new' ? undefined : 'r1',
      lines: [],
      unknown: [],
      conv: [],
      noPrice: 0,
      noPriceCodes: [],
      pkgLines: 0,
      libCost: 0,
      out: 1,
    })),
    counts: { add: 0, update: 0, locked: 0, exists: cards.length, nolines: 0, blocked: 0, lines: 0 },
    perBrand: {},
    needGrant: 0,
    hash: 'h' + cards.map((c) => c.mode ?? '-').join(''),
  });

  it('shows the choice per card, re-checks with it, and sends it with the hash of that check on load', async () => {
    const user = userEvent.setup();
    const csv = ['Recipe Code,Recipe Name,Item Code,Qty', 'GRM-MN-0001,Beef Steak,ING-1,100'].join(
      String.fromCharCode(10),
    );
    const file = new File([csv], 'cards.csv', { type: 'text/csv' });
    if (!file.arrayBuffer)
      (file as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = async () =>
        new TextEncoder().encode(csv).buffer as ArrayBuffer;
    onFetch((c) => {
      if (c.url === '/api/recipes/import?mode=dry-run') {
        const b = c.body as { cards: { code: string; name: string; mode?: string }[] };
        const p = planFor(b.cards.slice(0, 1));
        if (b.cards[0]!.mode === 'update') p.counts = { ...p.counts, exists: 0, update: 1 };
        if (b.cards[0]!.mode === 'new') p.counts = { ...p.counts, exists: 0, add: 1 };
        return { json: p };
      }
      if (c.url === '/api/recipes/import?mode=commit')
        return { json: { added: 0, updated: 1, revisions: 1, granted: 0, brands: ['GRM'] } };
      return undefined;
    });
    renderInShell(<RecipesScreen rows={[row(1)]} brands={brandList} workspaceId="b1" target={0.3} />);
    await user.click(screen.getByRole('button', { name: /Upload recipes/ }));
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, file);
    const pick = (await screen.findByLabelText(/What to do with/)) as HTMLSelectElement;
    expect(pick.value).toBe(''); // no choice yet: the card is skipped
    expect(screen.getByRole('button', { name: /Load 0 cards/ }).hasAttribute('disabled')).toBe(true);
    await user.selectOptions(pick, 'update');
    const again = calls.filter((c) => c.url.endsWith('mode=dry-run'));
    expect((again[again.length - 1]!.body as { cards: { mode?: string }[] }).cards[0]!.mode).toBe('update');
    const load = await screen.findByRole('button', { name: /Load 1 card/ });
    await user.click(load);
    await vi.waitFor(() => expect(calls.some((c) => c.url.endsWith('mode=commit'))).toBe(true));
    const sent = calls.find((c) => c.url.endsWith('mode=commit'))!.body as { cards: { mode?: string }[]; hash: string };
    expect(sent.cards[0]!.mode).toBe('update');
    expect(sent.hash).toBe('hupdate');
    expect(await screen.findByText(/started a new revision today/)).toBeTruthy();
  });
});

describe('Export card (D-98)', () => {
  it('downloads ONE card through the export endpoint, as the server names it; a refusal is shown, nothing is saved', async () => {
    const user = userEvent.setup();
    saved.xlsx.length = 0;
    onFetch((c) =>
      c.url === '/api/export/recipes-data?card=r1'
        ? { json: { filename: 'ISFC-GRM-MN-0001-recipe.xlsx', rows: [['Brand'], ['GRM']] } }
        : undefined,
    );
    renderInShell(<EditScreen detail={detailFixture()} brand={brand} brands={brandList} />);
    await user.click(screen.getByRole('button', { name: 'Export card' }));
    await vi.waitFor(() => expect(saved.xlsx).toEqual(['ISFC-GRM-MN-0001-recipe.xlsx']));
    expect(calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/export/'))).toHaveLength(1);
    expect(await screen.findByText(/Downloaded ISFC-GRM-MN-0001-recipe.xlsx/)).toBeTruthy();
    saved.xlsx.length = 0;
    onFetch((c) =>
      c.url.startsWith('/api/export/') ? { status: 404, json: { error: { message: 'Not found' } } } : undefined,
    );
    await user.click(screen.getByRole('button', { name: 'Export card' }));
    expect(await screen.findByText(/Not found/)).toBeTruthy();
    expect(saved.xlsx).toEqual([]);
  });
});

describe('stock class (D-97)', () => {
  it('Browse filters by Dry, Raw, Subrecipe (derived from the type) and Not set, in memory', async () => {
    const user = userEvent.setup();
    const rows = [
      row(1, { stockClass: 'Dry' }),
      row(2, { stockClass: 'Raw' }),
      row(3, { type: 'sub' }),
      row(4),
      row(5, { stockClass: 'Dry' }),
    ];
    renderInShell(<RecipesScreen rows={rows} brands={brandList} workspaceId="b1" target={0.3} />);
    const pick = screen.getByLabelText('Stock class');
    await user.selectOptions(pick, 'dry');
    expect(screen.getByText(/2 cards/)).toBeTruthy();
    await user.selectOptions(pick, 'raw');
    expect(screen.getByText(/1 card /)).toBeTruthy();
    await user.selectOptions(pick, 'sub');
    expect(screen.getByText(/1 card /)).toBeTruthy();
    await user.selectOptions(pick, 'none');
    expect(screen.getByText(/1 card /)).toBeTruthy(); // the Menu card with no class (the sub card is not "not set")
    expect(calls).toHaveLength(0);
  });

  it('the editor sets Dry/Raw on a Menu card and shows a fixed "Subrecipe" on a Sub-Recipe', async () => {
    const user = userEvent.setup();
    onFetch((c) => (c.method === 'PATCH' ? { json: detailFixture({ version: 1 }) } : undefined));
    const { unmount } = renderInShell(<EditScreen detail={detailFixture()} brand={brand} brands={brandList} />);
    await user.selectOptions(screen.getByLabelText('Stock class'), 'Raw');
    await vi.waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const p = calls.find((c) => c.method === 'PATCH');
    expect(p!.body).toEqual({ version: 0, stockClass: 'Raw' });
    unmount();
    cleanup();
    const sub = detailFixture();
    sub.recipe.type = 'SUB';
    renderInShell(<EditScreen detail={sub} brand={brand} brands={brandList} />);
    const fixed = screen.getByLabelText('Stock class') as HTMLSelectElement;
    expect(fixed.disabled).toBe(true);
    expect(fixed.value).toBe('Subrecipe');
  });
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
    renderInShell(<SettingsScreen settings={settings} brands={brands} clients={[]} impact={[]} />);
    const pkg = screen.getAllByDisplayValue('10.00')[0]!;
    await user.clear(pkg);
    await user.type(pkg, '12');
    await user.tab();
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ version: 4, pkg: 0.12 });
  });
  it('the add-brand row carries a logo box; non-GM roles do not get the brand tools', () => {
    renderInShell(<SettingsScreen settings={settings} brands={brands} clients={[]} impact={[]} />);
    expect(screen.getByText('Brand logo')).toBeTruthy();
    expect(screen.getByText('Choose image')).toBeTruthy();
    expect(screen.getByText('No logo')).toBeTruthy();
    cleanup();
    renderInShell(<SettingsScreen settings={settings} brands={brands} clients={[]} impact={[]} />, 'cc');
    expect(screen.queryByText('Brand logo')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });
});
