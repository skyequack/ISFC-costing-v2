import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { brandVars, palette } from '@/lib/brand/palette';

const root = path.resolve(__dirname, '..');
const legacySrc = fs.readFileSync(path.join(root, 'legacy/app.html'), 'utf8');
const start = legacySrc.indexOf('function hex2rgb(');
const end = legacySrc.indexOf('function brandPal(');

// Legacy functions evaluated verbatim from the frozen oracle.
const legacy = new Function(`${legacySrc.slice(start, end)}; return { palette };`)() as {
  palette: (hex: string, ink?: string) => Record<string, string>;
};

interface SeedBrand {
  id: string;
  code: string;
  color?: string;
  ink?: string;
}
const brands: SeedBrand[] = JSON.parse(fs.readFileSync(path.join(root, 'prisma/seed-data/brands.json'), 'utf8'));

describe('brand palette golden (legacy oracle)', () => {
  it('oracle extraction found the functions', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it('seed has the 14 brands', () => expect(brands).toHaveLength(14));

  it.each(brands.map((b) => [b.code, b] as const))('%s matches legacy palette()', (_code, b) => {
    const color = b.color || '#BB5E1E'; // legacy brandColor()
    expect(palette(color, b.ink)).toEqual(legacy.palette(color, b.ink));
  });

  it('brandVars string has the legacy shape and values', () => {
    const b = brands.find((x) => x.code === 'SLS')!;
    const p = legacy.palette(b.color!, b.ink);
    expect(brandVars(b)).toBe(
      `--bc:${p.base};--bc-tx:${p.text};--bc-sd:${p.solid};--bc-on:${p.onSolid};` +
        `--bc-tt:${p.tint};--bc-sf:${p.soft};--bc-wa:${p.wash};--bc-md:${p.mid}`,
    );
  });

  it('invalid colours fall back to the house orange like legacy', () => {
    expect(palette('not-a-colour')).toEqual(legacy.palette('not-a-colour'));
    expect(palette('#FFF', 'bad')).toEqual(legacy.palette('#FFF', 'bad'));
  });
});
