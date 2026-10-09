/**
 * Recipe reference graph (D-13). The editor, API and importer call assertAcyclic() before saving;
 * the costing engine keeps its own `circular` detection as a safety net.
 * Code matching is case-insensitive and trimmed (conservative: requisition matches case-insensitively).
 */
export interface GraphRecipe {
  code: string;
  lines: ReadonlyArray<{ code: string }>;
}

export class CycleError extends Error {
  constructor(readonly path: string[]) {
    super(`Circular recipe reference: ${path.join(' -> ')}`);
    this.name = 'CycleError';
  }
}

const key = (c: string) =>
  String(c ?? '')
    .trim()
    .toUpperCase();

/** Returns the first cycle found as a list of codes (first == last), or null. Iterative DFS, safe for deep graphs. */
export function findCycle(recipes: ReadonlyArray<GraphRecipe>): string[] | null {
  /* Recipes sharing a code (case-insensitively) are ONE node whose edges are the union of all their lines,
     so a cycle through either duplicate is never hidden by the other. */
  const byKey = new Map<string, { code: string; targets: Set<string> }>();
  for (const r of recipes) {
    const k = key(r.code);
    const node = byKey.get(k) ?? { code: r.code, targets: new Set<string>() };
    for (const l of r.lines ?? []) {
      const t = key(l.code);
      if (t) node.targets.add(t);
    }
    byKey.set(k, node);
  }
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done

  for (const start of byKey.keys()) {
    if (state.get(start)) continue;
    const stack: { k: string; edges: string[]; i: number }[] = [];
    const push = (k: string) => {
      state.set(k, 1);
      const edges = [...byKey.get(k)!.targets].filter((c) => byKey.has(c));
      stack.push({ k, edges, i: 0 });
    };
    push(start);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      if (top.i >= top.edges.length) {
        state.set(top.k, 2);
        stack.pop();
        continue;
      }
      const next = top.edges[top.i++]!;
      const st = state.get(next);
      if (st === 1) {
        const from = stack.findIndex((f) => f.k === next);
        const names = stack.slice(from).map((f) => byKey.get(f.k)!.code);
        return [...names, byKey.get(next)!.code];
      }
      if (!st) push(next);
    }
  }
  return null;
}

export function assertAcyclic(recipes: ReadonlyArray<GraphRecipe>): void {
  const c = findCycle(recipes);
  if (c) throw new CycleError(c);
}

/** Convenience for a save: replace/insert `candidate` (matched by `previousCode ?? candidate.code`) and check. */
export function assertAcyclicWith(
  recipes: ReadonlyArray<GraphRecipe>,
  candidate: GraphRecipe,
  previousCode?: string,
): void {
  const skip = key(previousCode ?? candidate.code);
  assertAcyclic([...recipes.filter((r) => key(r.code) !== skip), candidate]);
}
