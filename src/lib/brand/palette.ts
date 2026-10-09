/**
 * Brand palette — line-for-line port of legacy/app.html 1236-1349 (hex2rgb … palette, brandVars).
 * Golden-tested against the legacy functions for all 14 brands (tests/palette.test.ts).
 */
type RGB = number[];

export function hex2rgb(h: unknown): RGB | null {
  let s = String(h || '')
    .trim()
    .replace('#', '');
  if (s.length === 3)
    s = s
      .split('')
      .map((x) => x + x)
      .join('');
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export function rgb2hex(r: RGB): string {
  return (
    '#' +
    r
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
      .toUpperCase()
  );
}

export function rgb2hsl(c: RGB): [number, number, number] {
  const r = c[0]! / 255,
    g = c[1]! / 255,
    b = c[2]! / 255;
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b),
    d = mx - mn;
  let h = 0;
  const l = (mx + mn) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) {
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

export function hsl2rgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s,
    x = c * (1 - Math.abs(((h / 60) % 2) - 1)),
    m = l - c / 2;
  let t: RGB = [0, 0, 0];
  if (h < 60) t = [c, x, 0];
  else if (h < 120) t = [x, c, 0];
  else if (h < 180) t = [0, c, x];
  else if (h < 240) t = [0, x, c];
  else if (h < 300) t = [x, 0, c];
  else t = [c, 0, x];
  return t.map((v) => (v + m) * 255);
}

export function relLum(c: RGB): number {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
}

export function contrastWhite(c: RGB): number {
  const L = relLum(c);
  return 1.05 / (L + 0.05);
}

export function shade(hex: string, L: number): string {
  const c = hex2rgb(hex);
  if (!c) return hex;
  const h = rgb2hsl(c);
  return rgb2hex(hsl2rgb(h[0], h[1], L));
}

export function readable(hex: string, target?: number): string {
  const c = hex2rgb(hex);
  if (!c) return hex;
  target = target || 4.5;
  if (contrastWhite(c) >= target) return rgb2hex(c);
  const h = rgb2hsl(c);
  for (let L = h[2]; L >= 0.1; L -= 0.02) {
    const t = hsl2rgb(h[0], h[1], L);
    if (contrastWhite(t) >= target) return rgb2hex(t);
  }
  return rgb2hex(hsl2rgb(h[0], h[1], 0.1));
}

export interface Palette {
  base: string;
  text: string;
  solid: string;
  onSolid: string;
  tint: string;
  soft: string;
  wash: string;
  mid: string;
}

export const DEFAULT_BRAND_COLOR = '#BB5E1E';

export function palette(hex: string | null | undefined, ink?: string | null): Palette {
  const rgb = hex2rgb(hex);
  const base = rgb ? rgb2hex(rgb) : DEFAULT_BRAND_COLOR;
  const inkRgb = ink ? hex2rgb(ink) : null;
  const inkOk = !!(inkRgb && contrastWhite(inkRgb) >= 4.5);
  const onDark = contrastWhite(hex2rgb(base)!) >= 3.0;
  return {
    base,
    text: inkOk ? rgb2hex(inkRgb!) : readable(base, 4.5),
    solid: base,
    onSolid: onDark ? '#FFFFFF' : '#141414',
    tint: shade(base, 0.9),
    soft: shade(base, 0.8),
    wash: shade(base, 0.965),
    mid: shade(base, 0.62),
  };
}

/** Legacy brandColor(): empty/absent colour falls back to the house orange. */
export function brandPalette(brand: { color?: string | null; ink?: string | null } | null | undefined): Palette {
  return palette((brand && brand.color) || DEFAULT_BRAND_COLOR, brand && brand.ink);
}

export function brandVarsMap(p: Palette): Record<string, string> {
  return {
    '--bc': p.base,
    '--bc-tx': p.text,
    '--bc-sd': p.solid,
    '--bc-on': p.onSolid,
    '--bc-tt': p.tint,
    '--bc-sf': p.soft,
    '--bc-wa': p.wash,
    '--bc-md': p.mid,
  };
}

/** Same string as legacy brandVars(). */
export function brandVars(brand: { color?: string | null; ink?: string | null } | null | undefined): string {
  const p = brandPalette(brand);
  return (
    `--bc:${p.base};--bc-tx:${p.text};--bc-sd:${p.solid};--bc-on:${p.onSolid};` +
    `--bc-tt:${p.tint};--bc-sf:${p.soft};--bc-wa:${p.wash};--bc-md:${p.mid}`
  );
}
