/** Display helpers ported from legacy cur()/pct()/esc() (legacy/app.html 1486-1497). Rounding happens ONLY here (D-09). */
export function cur(v: number | null | undefined, d?: number, locale?: string): string {
  if (v == null || !isFinite(v)) return '-';
  const n = d == null ? 2 : d;
  return v.toLocaleString(locale, { minimumFractionDigits: n, maximumFractionDigits: n });
}

export function pct(v: number | null | undefined): string {
  return v == null || !isFinite(v) ? '-' : (v * 100).toFixed(1) + '%';
}

/** Server-side money text for audit rows: deterministic locale. */
export const money = (v: number | null | undefined, d?: number) => cur(v, d, 'en-US');
