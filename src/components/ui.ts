import type { CSSProperties } from 'react';

const cache = new Map<string, CSSProperties>();

/**
 * Parse a legacy inline-style string ("font-size:12px;color:var(--mute)") into a React style object, so ported
 * markup keeps the legacy declarations verbatim (UI is not redesigned, docs/UI_PORT.md). Cached by string.
 */
export function s(css: string): CSSProperties {
  const hit = cache.get(css);
  if (hit) return hit;
  const out: Record<string, string> = {};
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const k = decl.slice(0, i).trim();
    const v = decl.slice(i + 1).trim();
    if (!k) continue;
    const key = k.startsWith('--')
      ? k
      : k.replace(/^-(\w)/, (_, c: string) => c.toUpperCase()).replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
    out[key] = v;
  }
  cache.set(css, out as CSSProperties);
  return out as CSSProperties;
}
