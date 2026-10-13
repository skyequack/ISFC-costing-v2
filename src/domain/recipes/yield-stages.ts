/**
 * Three-stage line yield (D-70, D-85). A line may carry a thawing, a cutting/trimming and a cooking yield, each a fraction
 * (0.9 = 90%) or null = not set. The one yield costing reads is `y`; while any stage is set it is their product, a stage
 * left blank counting as 1. Doubles, no rounding: it is rounded only when shown.
 */
export interface YieldStages {
  yThaw?: number | null;
  yCut?: number | null;
  yCook?: number | null;
}

/** The product of the stages that are set, or null when none is (then the line keeps its own `y`). */
export function stagedYield(s: YieldStages): number | null {
  if (s.yThaw == null && s.yCut == null && s.yCook == null) return null;
  return (s.yThaw ?? 1) * (s.yCut ?? 1) * (s.yCook ?? 1);
}

/** The same range costing accepts for y: above 0 and up to 10. */
export const validYield = (y: number): boolean => Number.isFinite(y) && y > 0 && y <= 10;

/**
 * D-94: a raw material's default stages prefill a line when it is picked. Only a line with no stage of its own is touched (a
 * value the user typed is never overwritten), only the stages that have a default are copied, and the line's `y` becomes their
 * product. Returns null when nothing should change (no default, line already staged, or a product costing would not accept).
 */
export function prefillStages(
  item: YieldStages,
  line: YieldStages & { y?: number },
): { yThaw: number | null; yCut: number | null; yCook: number | null; y: number } | null {
  if (stagedYield(line) !== null) return null;
  if (line.y !== undefined && line.y !== 1) return null; // a yield typed by hand is never replaced
  const st = { yThaw: item.yThaw ?? null, yCut: item.yCut ?? null, yCook: item.yCook ?? null };
  const y = stagedYield(st);
  return y !== null && validYield(y) ? { ...st, y } : null;
}

/** Fractions are stored (0.9); the screen, the sheets and the audit text show percent (90) without float noise. '' = not set. */
export const pctText = (v: number | null | undefined): string => (v == null ? '' : String(Math.round(v * 10000) / 100));

/** A stage typed or uploaded as percent: blank = undefined (not given), 0 = null (100%, none), (0,1000] = the fraction, else 'bad'. */
export function parseStagePct(t: string): number | null | undefined | 'bad' {
  const x = t.replace(/[%,\s]/g, '');
  if (x === '') return undefined;
  const n = Number(x);
  if (!Number.isFinite(n) || n < 0 || n > 1000) return 'bad';
  return n === 0 ? null : n / 100;
}
