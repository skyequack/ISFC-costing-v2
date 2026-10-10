import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { Shell } from '@/components/shell/Shell';
import { permissionsFor, type Role } from '@/lib/permissions';
import type { RecipeDetail } from '@/lib/services/recipe-detail';

/** Shared mocks: next/navigation and Clerk are replaced by spies; fetch is a router the test controls. */
export const nav = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), path: '/dash' };

export interface Call {
  method: string;
  url: string;
  body: unknown;
}
export const calls: Call[] = [];
type Handler = (c: Call) => { status?: number; json?: unknown } | undefined;
const handlers: Handler[] = [];

export function onFetch(h: Handler): void {
  handlers.unshift(h);
}
export function resetFetch(): void {
  calls.length = 0;
  handlers.length = 0;
  nav.push.mockClear();
  nav.replace.mockClear();
  nav.refresh.mockClear();
}

export function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : (init?.body ?? undefined);
      const call: Call = { method: init?.method ?? 'GET', url: String(url), body };
      calls.push(call);
      for (const h of handlers) {
        const r = h(call);
        if (r)
          return new Response(JSON.stringify(r.json ?? {}), {
            status: r.status ?? 200,
            headers: { 'content-type': 'application/json' },
          });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

const brands = [
  { id: 'b1', name: 'Gourmet', code: 'GRM', color: '#BB5E1E', onSolid: '#FFFFFF', logoUrl: null, cards: 3 },
  { id: 'b2', name: 'Other', code: 'OTH', color: '#1F5C8B', onSolid: '#FFFFFF', logoUrl: null, cards: 1 },
];

export function renderInShell(el: ReactElement, role: Role = 'gm', workspaceId: string | null = 'b1') {
  return render(
    <Shell
      session={{
        name: 'Tester',
        role,
        permissions: permissionsFor(role),
        menusVisible: false,
        brands,
        workspace: brands.find((b) => b.id === workspaceId) ?? null,
      }}
    >
      {el}
    </Shell>,
  );
}

export const cost = {
  batch: 10,
  err: '',
  out: 1,
  orig: 10,
  food: 11.5,
  pkg: 0,
  del: 0,
  lab: 0,
  ops: 0,
  totalCost: 11.5,
  net: -11.5,
  sp: 0,
  fcPct: null,
  tcPct: null,
  npPct: null,
  gramTotal: 100,
  mlTotal: 0,
  eaTotal: 0,
  autoOut: 100,
  autoUom: 'Gram',
  bOut: 100,
  bUom: 'Gram',
  manualOut: false,
  portion: 100,
  weight: 100,
  suggest: 38.3,
  vatPrice: 0,
  unitCost: null,
  complete: true,
  issues: [],
};

export function detailFixture(over: Partial<RecipeDetail['recipe']> = {}): RecipeDetail {
  return {
    packaging: [],
    recipe: {
      id: 'r1',
      code: 'GRM-MN-0001',
      name: 'Beef Steak',
      category: 'Main Course',
      type: 'MENU',
      brandId: 'b1',
      output: 1,
      sellingPrice: 0,
      buffer: null,
      status: 'DRAFT',
      lockedBy: null,
      version: 0,
      photoSha: null,
      photoSize: null,
      updatedAt: new Date(),
      subQty: 0,
      subUom: 'Gram',
      batchOut: 0,
      batchUom: 'Gram',
      lockedAt: null,
      costAtLock: null,
      lines: [{ sortOrder: 0, code: 'ING-1', qty: 100, unit: 'Gram', y: 1, yp: null }],
      method: ['Grill it'],
      history: [],
      photoUrl: null,
      ...over,
    },
    view: {
      cost,
      sumQty: 100,
      lines: [
        { name: 'Beef', uom: 'Gram', price: 0.1, kind: 'item', err: '', needConv: false, qty: 100, y: 1, cost: 10 },
      ],
    },
    settings: {
      currency: 'SAR',
      pkg: 0.1,
      del: 0.1,
      lab: 0.25,
      ops: 0.05,
      buffer: 0.15,
      target: 0.3,
      vat: 0.15,
      priceDate: '2026-10-09',
    },
  } as RecipeDetail;
}
