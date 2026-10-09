import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every page route has a skeleton (loading.tsx), so a navigation shows something at once (D-59). */
function pageDirs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'api' || !statSync(p).isDirectory()) continue;
    if (existsSync(join(p, 'page.tsx'))) out.push(p);
    pageDirs(p, out);
  }
  return out;
}

describe('route skeletons', () => {
  const routes = pageDirs(join(process.cwd(), 'src', 'app')).filter((d) => !/sign-(in|up)/.test(d));
  it('finds the app routes', () => expect(routes.length).toBeGreaterThanOrEqual(15));
  it.each(routes.map((d) => [d.split('app')[1]!.replace(/\\/g, '/'), d]))('%s has a loading.tsx', (_name, dir) => {
    expect(existsSync(join(dir as string, 'loading.tsx'))).toBe(true);
  });
});
