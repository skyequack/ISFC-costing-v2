/**
 * Dated ingredient prices (D-100, B2). Pure: the price an ingredient had on a business day, from its history.
 *
 * `points` are the history rows in the order they were written (oldest first), each with the day it took effect (YYYY-MM-DD)
 * and the price before and after. `current` is the live `ingredient.price`.
 *  - no history: the current price (null stays null);
 *  - on or after the day of the LAST row: the current price (it is that row's new price, and the only one a later edit can change);
 *  - between rows: the new price of the last row on or before the day (several rows on one day: the last written wins);
 *  - before the first row: the price it replaced, or, when it had none, the first price it ever had (the earliest known).
 * A null price is never turned into 0.
 */
export interface PricePoint {
  /** the business day the change took effect, YYYY-MM-DD */
  on: string;
  oldPrice: number | null;
  newPrice: number | null;
}

export function priceOnDate(points: readonly PricePoint[], current: number | null, date: string): number | null {
  if (!points.length) return current;
  let at = -1;
  for (let i = 0; i < points.length; i++) if (points[i]!.on <= date) at = i;
  if (at === -1) {
    const first = points[0]!;
    return first.oldPrice !== null ? first.oldPrice : first.newPrice;
  }
  if (points[points.length - 1]!.on <= date) return current;
  return points[at]!.newPrice;
}
