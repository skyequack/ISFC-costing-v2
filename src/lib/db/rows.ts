/** snake_case column -> camelCase key (the one naming rule between SQL and TypeScript). */
export function camelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Map a pg row (snake_case keys) to a camelCase object. Values are passed through untouched. */
export function camelRow<T extends object>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[camelKey(k)] = v;
  return out as T;
}

export function camelRows<T extends object>(rows: Record<string, unknown>[]): T[] {
  return rows.map((r) => camelRow<T>(r));
}
