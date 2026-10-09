import { describe, expect, it } from 'vitest';
import type { Queryable } from '@/lib/db/client';
import { assertBrandVisible, canSeeBrand, makeScope, visibleBrandIds } from '@/lib/db/scope';
import { getEnv } from '@/lib/env';

const fakeDb: Queryable = {
  query: (async (text: string, values?: unknown[]) => {
    if (text.includes('FROM brand')) return { rows: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }] };
    if (text.includes('FROM user_brand_access'))
      return { rows: values?.[0] === 'u-two' ? [{ brand_id: 'b1' }, { brand_id: 'b2' }] : [] };
    throw new Error(`unexpected query: ${text}`);
  }) as Queryable['query'],
};

describe('visibleBrandIds (D-35)', () => {
  it('GM sees every brand', async () => {
    expect((await visibleBrandIds({ id: 'g', role: 'gm' }, fakeDb)).brandIds).toEqual(['b1', 'b2', 'b3']);
  });

  it('non-GM sees only granted brands', async () => {
    expect((await visibleBrandIds({ id: 'u-two', role: 'cook' }, fakeDb)).brandIds).toEqual(['b1', 'b2']);
  });

  it('non-GM with no grants sees nothing', async () => {
    expect((await visibleBrandIds({ id: 'u-none', role: 'cc' }, fakeDb)).brandIds).toEqual([]);
  });

  it('out-of-scope or missing ids -> 404', () => {
    const scope = makeScope(['b1']);
    expect(canSeeBrand(scope, 'b1')).toBe(true);
    expect(() => assertBrandVisible(scope, 'b2')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => assertBrandVisible(scope, null)).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe('getEnv', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@h/db',
    DATABASE_URL_UNPOOLED: 'postgresql://u:p@h/db',
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk',
    CLERK_SECRET_KEY: 'sk-secret-value',
  } as unknown as NodeJS.ProcessEnv;

  it('parses and normalises INITIAL_GM_EMAILS', () => {
    const env = getEnv({ ...base, INITIAL_GM_EMAILS: ' A@x.com, b@Y.com ,' });
    expect(env.initialGmEmails).toEqual(['a@x.com', 'b@y.com']);
  });

  it('reports missing names but never values', () => {
    const bad = { ...base, CLERK_SECRET_KEY: '' } as NodeJS.ProcessEnv;
    expect(() => getEnv(bad)).toThrow(/CLERK_SECRET_KEY/);
    try {
      getEnv(bad);
    } catch (e) {
      expect(String(e)).not.toContain('postgresql://');
    }
  });
});
