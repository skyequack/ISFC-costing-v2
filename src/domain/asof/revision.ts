import type { CostItem, CostRecipe } from '../costing';
import { priceOnDate, type PricePoint } from './price';

/**
 * Costing by date (D-100, B3). Pure: which revision of a card, and which price of an item, was in force on a business day.
 * The costing engine is not touched; this only decides WHAT is fed to it for a day.
 */
export interface Revision {
  /** first day it was in force, YYYY-MM-DD */
  from: string;
  status: 'DRAFT' | 'LOCKED';
  recipe: CostRecipe;
}

/**
 * The revision production uses on `date` (revisions oldest first, the LAST one is the live card):
 *  - no revision was ever locked: the live card, as today (the caller flags the card);
 *  - otherwise only LOCKED revisions count: the newest locked one that started on or before the day (a newer draft is
 *    ignored until it is approved), or, for a day before the first locked one, the earliest locked one (never empty).
 * A revision counts from its start day even if it was approved later.
 */
export function pickRevision(revisions: readonly Revision[], date: string): Revision {
  const live = revisions[revisions.length - 1]!;
  const locked = revisions.filter((r) => r.status === 'LOCKED');
  if (!locked.length) return live;
  let best: Revision | undefined;
  for (const r of locked) if (r.from <= date) best = r;
  return best ?? locked[0]!;
}

/** True when no revision of the card was ever approved (the card is costed as it is today and flagged). */
export const neverLocked = (revisions: readonly Revision[]): boolean => !revisions.some((r) => r.status === 'LOCKED');

export interface CardHistory {
  code: string;
  /** the live card's start day and status (its recipe is the one in the base catalog) */
  liveFrom: string;
  liveStatus: 'DRAFT' | 'LOCKED';
  /** archived revisions, oldest first */
  archived: Revision[];
}

export interface ItemHistory {
  code: string;
  /** history rows oldest first (day taken, then the order written) */
  points: PricePoint[];
}

export interface AsOfInput {
  items: CostItem[];
  recipes: CostRecipe[];
}

/** The card list of `base` with every card's revision and every item's price as on `date`. Same objects when nothing differs. */
export function asOf(
  base: AsOfInput,
  cards: readonly CardHistory[],
  items: readonly ItemHistory[],
  date: string,
): AsOfInput {
  if (!cards.length && !items.length) return base;
  const hist = new Map(cards.map((c) => [c.code, c]));
  const priced = new Map(items.map((i) => [i.code, i]));
  const recipes = base.recipes.map((r) => {
    const h = hist.get(r.code);
    if (!h) return r;
    const revs: Revision[] = [...h.archived, { from: h.liveFrom, status: h.liveStatus, recipe: r }];
    return pickRevision(revs, date).recipe;
  });
  const its = base.items.map((it) => {
    const h = priced.get(it.code);
    if (!h) return it;
    const price = priceOnDate(h.points, it.price, date);
    return price === it.price ? it : { ...it, price };
  });
  return { items: its, recipes };
}

/**
 * Days that cost identically share a key: the index of the revision each history card uses and how many price changes of
 * each item are in force. One catalog is built per key, so a month costs once per period, not once per day.
 */
export function periodKey(cards: readonly CardHistory[], items: readonly ItemHistory[], date: string): string {
  const c = cards.map((h) => {
    const revs: Pick<Revision, 'from' | 'status'>[] = [...h.archived, { from: h.liveFrom, status: h.liveStatus }];
    const locked = revs.map((r, i) => ({ r, i })).filter((x) => x.r.status === 'LOCKED');
    if (!locked.length) return revs.length - 1;
    let best = locked[0]!.i;
    for (const x of locked) if (x.r.from <= date) best = x.i;
    return best;
  });
  const p = items.map((h) => {
    let n = 0;
    for (const x of h.points) if (x.on <= date) n++;
    return n;
  });
  return c.join(',') + '|' + p.join(',');
}
