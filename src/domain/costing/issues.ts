/**
 * D-42: completeness signal. `cost()` stays the exact legacy result; costWithIssues() adds
 * `complete` and `issues[]` WITHOUT changing any number. The walk mirrors the engine's traversal
 * (same `seen` copying) so it reports exactly the situations that make the engine cost a line as 0
 * or set `err`. Invariant (tested): `err !== ''` <=> `issues.length > 0`.
 *
 * Note: the costing engine has no depth limit, so "depth truncation" can only arise in requisition
 * expansion; that is reported there as the `truncated` flag (production/requisition.ts).
 */
import { cost, lineCost, num } from './engine';
import type { CostContext, CostRecipe, CostResult } from './types';

export type CostIssueKind =
  'no-price' | 'missing-conversion' | 'unknown-code' | 'not-a-sub-recipe' | 'circular' | 'no-batch-output';

export interface CostIssue {
  kind: CostIssueKind;
  /** Card being costed. */
  recipe: string;
  /** Codes from the costed card down to the card that holds the offending line. */
  path: string[];
  /** The line code (or, for circular / no-batch-output, the sub-recipe concerned). */
  code: string;
  detail?: { lineUnit?: string; itemUom?: string };
}

export interface CostWithIssues extends CostResult {
  complete: boolean;
  issues: CostIssue[];
}

function collect(top: CostRecipe, ctx: CostContext): CostIssue[] {
  const issues: CostIssue[] = [];
  const seenKeys = new Set<string>();
  const add = (i: CostIssue) => {
    const k = `${i.kind}|${i.path.join('>')}|${i.code}|${i.detail?.lineUnit ?? ''}`;
    if (seenKeys.has(k)) return;
    seenKeys.add(k);
    issues.push(i);
  };

  const walk = (rec: CostRecipe, seen: Set<string> | undefined, path: string[]) => {
    for (const l of rec.lines || []) {
      if (!l.code) continue;
      const c = lineCost(l, ctx, seen ? new Set(seen) : undefined);
      if (c.needConv) {
        const it = ctx.items.get(l.code);
        const target = it ? it.uom : c.uom;
        add({
          kind: 'missing-conversion',
          recipe: top.code,
          path,
          code: l.code,
          detail: { lineUnit: l.unit, itemUom: target },
        });
      }
      if (c.kind === 'item') {
        if (c.err) add({ kind: 'no-price', recipe: top.code, path, code: l.code });
      } else if (c.kind === 'none') {
        add({ kind: 'unknown-code', recipe: top.code, path, code: l.code });
      } else if (c.kind === 'menu') {
        add({ kind: 'not-a-sub-recipe', recipe: top.code, path, code: l.code });
      } else {
        /* sub: replay subUnitCost's seen handling on a fresh copy */
        const sub = ctx.recipes.get(l.code)!;
        const s2 = seen ? new Set(seen) : new Set<string>();
        if (s2.has(sub.code)) {
          add({ kind: 'circular', recipe: top.code, path, code: sub.code });
          continue;
        }
        s2.add(sub.code);
        walk(sub, s2, [...path, sub.code]);
        if (!(num(sub.batchOut) || num(sub.subQty) || 0))
          add({ kind: 'no-batch-output', recipe: top.code, path: [...path, sub.code], code: sub.code });
      }
    }
  };
  walk(top, undefined, [top.code]);
  return issues;
}

export function costWithIssues(rec: CostRecipe, ctx: CostContext): CostWithIssues {
  const issues = collect(rec, ctx);
  return { ...cost(rec, ctx), complete: issues.length === 0, issues };
}
