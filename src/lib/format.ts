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

/** Legacy fcClass (1516): pill class for a food-cost fraction against the target. */
export function fcClass(p: number | null | undefined, target: number): string {
  if (p == null) return 'p-gr';
  if (p <= target) return 'p-ok';
  if (p <= target * 1.25) return 'p-warn';
  return 'p-bad';
}

/** Width (%) and colour of the legacy "vs target" bar. */
export function fcBar(p: number | null | undefined, t: number): { w: number; col: string } {
  const w = p == null ? 0 : Math.min(100, (p / Math.max(t * 2, 0.01)) * 100);
  const col = p == null ? '#CFC5BB' : p <= t ? 'var(--grn)' : p <= t * 1.25 ? 'var(--warn)' : 'var(--bad)';
  return { w, col };
}
