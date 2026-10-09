/**
 * D-43 price-list import: the share an incoming price moves a stored one, and the review threshold.
 * Pure. `old == null` (no price on file) or `old === 0` never produces a variance (the dry-run shows "new price").
 */
export const PRICE_VARIANCE_THRESHOLD = 0.2;

export interface PriceMove {
  /** (new - old) / old, or null when there is no meaningful old price */
  pct: number | null;
  /** strictly beyond the threshold: exactly 20.0% is NOT flagged */
  check: boolean;
}

export function priceMove(oldPrice: number | null, newPrice: number | null, threshold = PRICE_VARIANCE_THRESHOLD): PriceMove {
  if (newPrice == null || oldPrice == null || oldPrice === 0) return { pct: null, check: false };
  const pct = (newPrice - oldPrice) / oldPrice;
  return { pct, check: Math.abs(pct) > threshold + 1e-12 };
}

/** Existing flags are preserved verbatim; PRICE CHECK is appended once, joined with " | ". */
export function appendPriceCheck(flag: string): string {
  if (/PRICE CHECK/i.test(flag)) return flag;
  return flag ? `${flag} | PRICE CHECK` : 'PRICE CHECK';
}
