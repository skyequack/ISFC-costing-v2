import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { assertBrandVisible, canSeeBrand, makeScope, visibleBrandIds } from '@/lib/db/scope';
import { getEnv } from '@/lib/env';

const fakeDb = {
  brand: { findMany: async () => [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }] },
  userBrandAccess: {
    findMany: async ({ where }: { where: { userId: string } }) =>
      where.userId === 'u-two' ? [{ brandId: 'b1' }, { brandId: 'b2' }] : [],
  },
} as unknown as PrismaClient;

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
    DIRECT_URL: 'postgresql://u:p@h/db',
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
