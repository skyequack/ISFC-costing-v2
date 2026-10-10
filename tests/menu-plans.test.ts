import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  createCardMatcher,
  lookupFor,
  mealRank,
  menuDemand,
  menuPreview,
  planCost,
  planDay,
  planWeek,
  planFamily,
  planTok,
  prepDemand,
  weekdayOf,
  type PlanMenu,
} from '@/domain/menu-plans';
import { PLAN_ALIAS, MENU_DAYS } from '@/data';
import { goldenContext, goldenState } from './helpers/golden';

const root = path.resolve(__dirname, '..');
const legacy = fs.readFileSync(path.join(root, 'legacy/app.html'), 'utf8').split('\n');
const plan = JSON.parse(fs.readFileSync(path.join(root, 'db/seed-data/menu-plan.json'), 'utf8')) as {
  menu: string;
  days: string[];
  rows: { m: string; d: Record<string, { n: string; c?: string; k?: string }> }[];
}[];

/** The legacy matcher, evaluated from the frozen file (lines 1664-1691) against the golden recipes. */
function legacyFinder(): (name: string) => string | null {
  const src = legacy.slice(1663, 1691).join('\n');
  const sandbox: Record<string, unknown> = { S: { recipes: goldenState.recipes } };
  vm.runInNewContext(src + '\nthis.planFindCard = planFindCard;', sandbox);
  return sandbox.planFindCard as (name: string) => string | null;
}

const toMenus = (): PlanMenu[] =>
  plan.map((m, i) => ({
    id: `m${i}`,
    name: m.menu,
    days: m.days,
    rows: m.rows.map((r) => ({
      meal: r.m,
      cells: Object.fromEntries(
        Object.entries(r.d).map(([d, c]) => [
          d,
          { label: c.n, kind: c.k === 'card' ? 'RECIPE' : c.k === 'item' ? 'ITEM' : 'NONE', code: c.c ?? null },
        ]),
      ),
    })),
  })) as PlanMenu[];

describe('plan matcher equals the legacy planFindCard for every menu cell (docs/TESTING.md §1)', () => {
  const legacyFind = legacyFinder();
  const find = createCardMatcher(goldenState.recipes, PLAN_ALIAS);
  const names = [...new Set(plan.flatMap((m) => m.rows.flatMap((r) => Object.values(r.d).map((c) => c.n))))];

  it('covers all distinct dish texts', () => expect(names.length).toBeGreaterThan(150));
  it('identical result for every dish text', () => {
    let diff = 0;
    for (const n of names) if ((find(n) ?? null) !== (legacyFind(n) ?? null)) diff++;
    expect(diff).toBe(0);
  });
  it('legacy is deterministic on repeats (memoised)', () => {
    expect(find('Chicken Tawouk')).toBe(find('Chicken Tawouk'));
  });
});

describe('plan helpers', () => {
  const ctx = goldenContext();
  const L = lookupFor(ctx, goldenState.recipes, PLAN_ALIAS);
  const menus = toMenus();

  it('tokeniser: stems plurals, drops stop words', () => {
    expect(planTok('Grilled Chickens with the Rice')).toEqual(['grilled', 'chicken', 'rice']);
    expect(planFamily('ARABIC - SENIOR')).toBe('ARABIC');
    expect(mealRank('lunch  muslim')).toBe(2);
    expect(mealRank('SNACK')).toBe(99);
  });

  it('planCost: pointers re-cost; unmatched / missing / no price are labelled', () => {
    expect(planCost(undefined, L)).toEqual({ v: null, src: 'not matched' });
    expect(planCost({ label: 'x', kind: 'RECIPE', code: 'NOPE-1' }, L).src).toBe('card missing');
    expect(planCost({ label: 'x', kind: 'ITEM', code: 'NOPE-1' }, L).src).toBe('item missing');
    const card = planCost({ label: 'x', kind: 'RECIPE', code: 'GRM-MN-0001' }, L);
    expect(card.src).toBe('card');
    expect(card.v).toBeGreaterThan(0);
  });

  it('planDay totals priced cells and counts the unpriced', () => {
    const d = planDay(menus[0]!, 'SATURDAY', L);
    expect(d.priced + d.unp).toBeGreaterThan(0);
  });

  it('planWeek is the sum of the day totals', () => {
    const m = menus[0]!;
    expect(planWeek(m, L)).toBeCloseTo(
      m.days.reduce((a, d) => a + planDay(m, d, L).tot, 0),
      9,
    );
  });

  it('weekday: Saturday-first week', () => {
    expect(weekdayOf('2026-10', '10', MENU_DAYS)).toBe('SATURDAY'); // 10 Oct 2026 is a Saturday
    expect(weekdayOf('2026-10', '11', MENU_DAYS)).toBe('SUNDAY');
    expect(weekdayOf('2026-10', '16', MENU_DAYS)).toBe('FRIDAY');
  });

  it('menuDemand adds headcounts per dish; prepDemand accumulates raw material', () => {
    const pax = new Map([
      [menus[0]!.id, 10],
      [menus[1]!.id, 5],
    ]);
    const d = menuDemand(menus, pax, 'SATURDAY', L);
    for (const e of Object.values(d.tot)) expect(e.q).toBeGreaterThan(0);
    const req = { items: ctx.items, recipes: goldenState.recipes, conv: ctx.conv };
    const p = prepDemand(menus, pax, 'SATURDAY', L, req);
    expect(p.people).toBe(15);
    expect(p.menus).toHaveLength(2);
    for (const r of p.rows) expect(r.qty).toBeGreaterThanOrEqual(0);
  });
});

describe('menu plan defensive branches (menus with missing rows / days / cells)', () => {
  const ctx = goldenContext();
  const L = lookupFor(ctx, goldenState.recipes, PLAN_ALIAS);
  const bare = { id: 'x', name: 'Bare - menu' } as unknown as PlanMenu;
  it('tolerates a menu without rows or days', () => {
    expect(planDay(bare, 'SATURDAY', L)).toEqual({ tot: 0, priced: 0, unp: 0 });
    expect(planWeek(bare, L)).toBe(0);
    expect(menuPreview(bare, 'SATURDAY', L)).toEqual({ hit: [], miss: [] });
    const empty = {
      id: 'e',
      name: 'Empty',
      days: ['SATURDAY'],
      rows: [{ meal: 'LUNCH', cells: {} }],
    } as unknown as PlanMenu;
    expect(planDay(empty, 'SATURDAY', L)).toEqual({ tot: 0, priced: 0, unp: 0 });
    expect(menuPreview(empty, 'SATURDAY', L)).toEqual({ hit: [], miss: [] });
  });
  it('a card cell whose code is not a card, and an ITEM cell resolved through a newer card or reported as unpriced', () => {
    const m = {
      id: 'm',
      name: 'M',
      days: ['SATURDAY'],
      rows: [
        { meal: 'LUNCH', cells: { SATURDAY: { label: 'Grilled Beef Steak', kind: 'ITEM', code: 'NO-SUCH-ITEM' } } },
        { meal: 'DINNER', cells: { SATURDAY: { label: 'zzz', kind: 'RECIPE', code: 'NOPE' } } },
      ],
    } as unknown as PlanMenu;
    expect(menuPreview(m, 'SATURDAY', L).miss).toEqual(['zzz']);
    expect(planCost({ label: 'Grilled Beef Steak', kind: 'ITEM', code: 'NO-SUCH-ITEM' }, L).src).toMatch(
      /new card|item missing/,
    );
    const priced = [...ctx.items.values()].find((i) => i.price == null)!;
    expect(planCost({ label: 'qqq', kind: 'ITEM', code: priced.code }, L)).toEqual({ v: null, src: 'no price' });
  });
});
