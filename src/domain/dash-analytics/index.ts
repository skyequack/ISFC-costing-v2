/**
 * Dashboard analytics (D-65…D-67). Pure: already-costed figures in, plain numbers out. Doubles only, no rounding
 * (round at display/export). Costing is never touched; this module only reads its results.
 */

export type Quadrant = 'star' | 'plowhorse' | 'puzzle' | 'dog';

/** Minimum classifiable menu items before the matrix classifies (D-66). */
export const MATRIX_MIN_ITEMS = 4;

/** Kasavana-Smith popularity cut: 70% of an even share of the portions. */
export const POPULARITY_SHARE = 0.7;

export interface MatrixInput {
  code: string;
  name: string;
  /** portions produced in the filtered range */
  portions: number;
  /** selling price per portion; <= 0 or null = not priced */
  sp: number | null;
  /** food cost per portion (incl. buffer) */
  food: number;
}

export interface MatrixPoint {
  code: string;
  name: string;
  portions: number;
  /** share of all classified portions, 0..1 */
  share: number;
  /** sp - food, per portion */
  contribution: number;
  quadrant: Quadrant;
}

export interface MenuMatrix {
  /** null when fewer than MATRIX_MIN_ITEMS items could be classified */
  points: MatrixPoint[] | null;
  /** popularity cut in portions (70% x total / N) */
  popularityCut: number | null;
  /** portion-weighted mean contribution per portion */
  marginCut: number | null;
  classified: number;
  /** cards with production but no selling price (null is not 0) */
  unpriced: number;
  /** priced cards with no production in the range */
  noProduction: number;
  /** priced, produced cards whose food cost is not a finite number (cost-engine error state) */
  unvalued: number;
  totalPortions: number;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Menu-engineering matrix. Only priced (sp > 0) cards with portions > 0 are classified; a value equal to a cut counts
 * as high. Cuts are computed over exactly the rows passed in, so a caller that scopes first cannot leak other brands.
 */
export function menuMatrix(rows: ReadonlyArray<MatrixInput>, minItems = MATRIX_MIN_ITEMS): MenuMatrix {
  let unpriced = 0;
  let noProduction = 0;
  let unvalued = 0;
  const live: MatrixInput[] = [];
  for (const r of rows) {
    const hasProd = finite(r.portions) && r.portions > 0;
    const priced = finite(r.sp) && r.sp > 0;
    if (hasProd && !priced) unpriced++;
    else if (!hasProd && priced) noProduction++;
    else if (hasProd && priced) {
      if (finite(r.food)) live.push(r);
      else unvalued++;
    }
  }
  const total = live.reduce((a, r) => a + r.portions, 0);
  if (live.length < Math.max(1, minItems))
    return {
      points: null,
      popularityCut: null,
      marginCut: null,
      classified: live.length,
      unpriced,
      noProduction,
      unvalued,
      totalPortions: total,
    };
  const popularityCut = (POPULARITY_SHARE * total) / live.length;
  const marginCut = live.reduce((a, r) => a + (r.sp! - r.food) * r.portions, 0) / total;
  const points = live
    .map((r): MatrixPoint => {
      const contribution = r.sp! - r.food;
      const pop = r.portions >= popularityCut;
      const mar = contribution >= marginCut;
      return {
        code: r.code,
        name: r.name,
        portions: r.portions,
        share: r.portions / total,
        contribution,
        quadrant: pop ? (mar ? 'star' : 'plowhorse') : mar ? 'puzzle' : 'dog',
      };
    })
    .sort((a, b) => b.portions - a.portions || a.code.localeCompare(b.code));
  return {
    points,
    popularityCut,
    marginCut,
    classified: live.length,
    unpriced,
    noProduction,
    unvalued,
    totalPortions: total,
  };
}

export interface RiskInput {
  code: string;
  name: string;
  portions: number;
  sp: number | null;
  food: number;
}

export interface RiskRow {
  code: string;
  name: string;
  portions: number;
  /** food cost % of selling price, as a fraction */
  fcPct: number;
  /** food cost per portion above what the target allows: food - sp x target */
  overPerPortion: number;
  /** overPerPortion x portions */
  atRisk: number;
}

/** Margin at risk = sum of max(0, food - sp x target) x portions, per priced card with production (weighted, exact). */
export function marginAtRisk(rows: ReadonlyArray<RiskInput>, target: number): { rows: RiskRow[]; total: number } {
  const out: RiskRow[] = [];
  for (const r of rows) {
    if (!finite(r.sp) || r.sp <= 0 || !(r.portions > 0) || !finite(r.food)) continue;
    const over = r.food - r.sp * target;
    if (!(over > 0)) continue;
    out.push({
      code: r.code,
      name: r.name,
      portions: r.portions,
      fcPct: r.food / r.sp,
      overPerPortion: over,
      atRisk: over * r.portions,
    });
  }
  out.sort((a, b) => b.atRisk - a.atRisk || a.code.localeCompare(b.code));
  return { rows: out, total: out.reduce((a, r) => a + r.atRisk, 0) };
}

export interface OverTargetRow {
  code: string;
  name: string;
  fcPct: number;
  /** fcPct - target, as a fraction (display as points) */
  gap: number;
}

/** Priced cards over the food-cost target, worst gap first. */
export function overTarget(
  rows: ReadonlyArray<{ code: string; name: string; sp: number | null; fcPct: number | null }>,
  target: number,
): OverTargetRow[] {
  const out: OverTargetRow[] = [];
  for (const r of rows)
    if (finite(r.sp) && r.sp > 0 && finite(r.fcPct) && r.fcPct > target)
      out.push({ code: r.code, name: r.name, fcPct: r.fcPct, gap: r.fcPct - target });
  return out.sort((a, b) => b.gap - a.gap || a.code.localeCompare(b.code));
}

export type AbcClass = 'A' | 'B' | 'C';

export interface ParetoRow<T> {
  item: T;
  cost: number;
  /** share of the total cost, 0..1 */
  share: number;
  /** running share including this row */
  cumulative: number;
  cls: AbcClass;
}

/** Cost drivers: highest spend first with running share; A = first 80%, B = up to 95%, C = the tail. */
export function pareto<T>(items: ReadonlyArray<{ item: T; cost: number }>): ParetoRow<T>[] {
  const rows = items.filter((x) => finite(x.cost) && x.cost > 0).sort((a, b) => b.cost - a.cost);
  const total = rows.reduce((a, x) => a + x.cost, 0);
  let run = 0;
  return rows.map((x) => {
    const before = total > 0 ? run / total : 0;
    run += x.cost;
    const cumulative = total > 0 ? run / total : 0;
    return {
      item: x.item,
      cost: x.cost,
      share: total > 0 ? x.cost / total : 0,
      cumulative,
      cls: before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C',
    };
  });
}

/** Food-cost spread (D-84): bands of this many points of food cost, the last band open-ended. */
export const FC_BAND_STEP = 0.05;
export const FC_BANDS = 11;

export interface FcBin {
  /** lower edge, 0..1 */
  from: number;
  /** upper edge (exclusive), or null for the open last band */
  to: number | null;
  /** portions produced of cards at or under the target */
  within: number;
  /** portions produced of cards over the target */
  over: number;
  cards: number;
}

/**
 * Portions per food-cost band, split at the target (D-84). Only priced cards (finite fcPct) with production are
 * counted; a card at exactly the target is within. Pure: the caller passes costed values and portions.
 */
export function fcHistogram(rows: ReadonlyArray<{ fcPct: number | null; portions: number }>, target: number): FcBin[] {
  const bins: FcBin[] = Array.from({ length: FC_BANDS }, (_, i) => ({
    from: i * FC_BAND_STEP,
    to: i === FC_BANDS - 1 ? null : (i + 1) * FC_BAND_STEP,
    within: 0,
    over: 0,
    cards: 0,
  }));
  for (const r of rows) {
    if (!finite(r.fcPct) || !(r.portions > 0)) continue;
    // the epsilon keeps a value on a band edge in its own band (0.3 / 0.05 is 5.999…)
    const i = Math.min(FC_BANDS - 1, Math.max(0, Math.floor(r.fcPct / FC_BAND_STEP + 1e-9)));
    const b = bins[i]!;
    b.cards += 1;
    if (r.fcPct <= target) b.within += r.portions;
    else b.over += r.portions;
  }
  return bins;
}
