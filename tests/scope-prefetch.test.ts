import { describe, expect, it, vi } from 'vitest';
import type { Queryable } from '@/lib/db/client';
import { attachScope, canSeeBrand, visibleBrandIds } from '@/lib/db/scope';

const fake = (rows: Record<string, unknown>[]) => {
  const query = vi.fn(async () => ({ rows }));
  return Object.assign({ query } as unknown as Queryable, { query });
};

describe('scope read together with the session user (one round trip less per request)', () => {
  it('uses the prefetched scope for that user object and runs no query', async () => {
    const user = { id: 'u1', role: 'chef' as const };
    attachScope(user, ['b1', 'b2', 'b1']);
    const db = fake([{ brand_id: 'other' }]);
    const scope = await visibleBrandIds(user, db);
    expect(db.query).not.toHaveBeenCalled();
    expect(scope.brandIds).toEqual(['b1', 'b2']); // still built by makeScope: de-duplicated and frozen
    expect(canSeeBrand(scope, 'b2')).toBe(true);
    expect(canSeeBrand(scope, 'other')).toBe(false);
    expect(Object.isFrozen(scope.brandIds)).toBe(true);
  });

  it('an empty prefetched scope still means "sees nothing", not "ask the database"', async () => {
    const user = { id: 'u2', role: 'chef' as const };
    attachScope(user, []);
    const db = fake([{ brand_id: 'leak' }]);
    expect((await visibleBrandIds(user, db)).brandIds).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('a different user object (even with the same id) is looked up as before', async () => {
    attachScope({ id: 'u3', role: 'chef' as const }, ['b1']);
    const db = fake([{ brand_id: 'b9' }]);
    expect((await visibleBrandIds({ id: 'u3', role: 'chef' }, db)).brandIds).toEqual(['b9']);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('GM without a prefetch reads every brand', async () => {
    const db = fake([{ id: 'a' }, { id: 'b' }]);
    expect((await visibleBrandIds({ id: 'g', role: 'gm' }, db)).brandIds).toEqual(['a', 'b']);
  });
});
