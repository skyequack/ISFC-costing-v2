/**
 * Theoretical vs actual usage (D-74). Pure: production and library data in, plain numbers out. Doubles only, no rounding
 * (round at display/export). The requisition expansion is only observed (`onLine`), never changed.
 *
 * Theoretical T = gross requisition usage in the ingredient's purchase unit, no buffer: qty / output x portions / y, with
 * the same yield rule as costing (y outside (0,10] counts as 1). Each line carries an allowance p (the line's own yp, else
 * the card's buffer, else the settings buffer; the card is the TOP-level card, as costing applies it once there), so the
 * ceiling is T + sum(T_line x p_line). Actual U = opening + receipts - closing.
 */
import { num, type CostRecipe } from '../costing';
import { newReqResult, reqExpand, type ReqContext } from '../production/requisition';

/** U below this share of T is "under" (D-74: 20% tolerance). */
export const UNDER_SHARE = 0.8;

export interface Usage {
  /** T in purchase units */
  theoretical: number;
  /** sum of T_line x p_line: the allowance in purchase units */
  extra: number;
  /** an unconvertible line reaches this ingredient: its usage is understated, so no verdict */
  flagged: boolean;
}

export type Verdict = 'within' | 'over' | 'under';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** The yield costing uses for a line: outside (0,10] is a data error and counts as 1. */
export function costingYield(y: unknown): number {
  const n = num(y);
  return n > 0 && n <= 10 ? n : 1;
}

/** Allowance fraction of one top-level line: its own yp, else the card's buffer, else the settings buffer (as cost()). */
export function lineAllowance(recipe: CostRecipe, line: { yp?: number | null }, settingsBuffer: number): number {
  if (line.yp != null) return num(line.yp) / 100;
  return recipe.buffer != null ? num(recipe.buffer) : num(settingsBuffer);
}

/**
 * Adds the usage of `portions` of a card to `into`, keyed by ingredient code. Each top-level line is expanded on its own so
 * everything reached through it (sub-recipes included) carries that line's allowance, exactly as costing applies it.
 */
export function theoreticalUsage(
  recipe: CostRecipe,
  portions: number,
  ctx: ReqContext,
  settingsBuffer: number,
  into: Map<string, Usage>,
): void {
  if (!(portions > 0)) return;
  for (const line of recipe.lines || []) {
    if (!line.code) continue;
    const p = lineAllowance(recipe, line, settingsBuffer);
    reqExpand({ ...recipe, lines: [line] }, portions, ctx, newReqResult(), 0, (e) => {
      let u = into.get(e.line.code);
      if (!u) into.set(e.line.code, (u = { theoretical: 0, extra: 0, flagged: false }));
      if (!e.convertible) {
        u.flagged = true;
        return;
      }
      const t = ((num(e.line.qty) / e.out) * e.portions) / costingYield(e.line.y) / (e.factor ?? 1);
      u.theoretical += t;
      u.extra += t * p;
    });
  }
}

/** Opening + receipts - closing, in purchase units. Any missing leg = not counted = null (never 0). */
export function actualUsage(
  opening: number | null | undefined,
  receipts: number,
  closing: number | null | undefined,
): number | null {
  if (!finite(opening) || !finite(closing)) return null;
  return opening + receipts - closing;
}

/** U <= ceiling is within; U > ceiling is over; U < 80% of T is under (checked first: it cannot also be over). */
export function verdictOf(theoretical: number, ceiling: number, actual: number): Verdict {
  if (theoretical > 0 && actual < UNDER_SHARE * theoretical) return 'under';
  if (actual > ceiling + 1e-9 * Math.max(1, Math.abs(ceiling))) return 'over';
  return 'within';
}

export interface TvaInput {
  code: string;
  name: string;
  uom: string;
  /** purchase price per purchase unit; null = unpriced (quantity only) */
  price: number | null;
  usage: Usage;
  /** null = no opening or closing count for it */
  actual: number | null;
}

export interface TvaRow {
  code: string;
  name: string;
  uom: string;
  theoretical: number;
  /** T + allowance */
  ceiling: number;
  actual: number | null;
  /** actual - theoretical; null when actual is n/a or the ingredient is flagged */
  deviation: number | null;
  /** deviation x price; null when there is no deviation or no price */
  value: number | null;
  /** theoretical x price; null when unpriced */
  theoreticalValue: number | null;
  verdict: Verdict | null;
  flagged: boolean;
  priced: boolean;
}

export function tvaRow(i: TvaInput): TvaRow {
  const T = i.usage.theoretical;
  const ceiling = T + i.usage.extra;
  const actual = i.usage.flagged ? null : i.actual;
  const deviation = actual === null ? null : actual - T;
  const priced = finite(i.price);
  return {
    code: i.code,
    name: i.name,
    uom: i.uom,
    theoretical: T,
    ceiling,
    actual,
    deviation,
    value: deviation !== null && priced ? deviation * (i.price as number) : null,
    theoreticalValue: priced ? T * (i.price as number) : null,
    verdict: actual === null ? null : verdictOf(T, ceiling, actual),
    flagged: i.usage.flagged,
    priced,
  };
}

/**
 * Biggest deviation first: rows with a deviation by |value| (unpriced ones by |quantity|, after the priced), then the
 * theoretical-only rows by theoretical value.
 */
export function rankTva(rows: TvaRow[]): TvaRow[] {
  const rank = (r: TvaRow): [number, number] =>
    r.deviation === null
      ? [0, r.theoreticalValue ?? 0]
      : r.value !== null
        ? [3, Math.abs(r.value)]
        : [2, Math.abs(r.deviation)];
  return [...rows].sort((a, b) => {
    const [ga, va] = rank(a);
    const [gb, vb] = rank(b);
    return gb - ga || vb - va || a.code.localeCompare(b.code);
  });
}
