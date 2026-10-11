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
