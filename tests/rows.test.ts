import { describe, expect, it } from 'vitest';
import { camelKey, camelRow, camelRows } from '@/lib/db/rows';

describe('row mapping (snake_case SQL -> camelCase TS)', () => {
  it('converts keys', () => {
    expect(camelKey('clerk_user_id')).toBe('clerkUserId');
    expect(camelKey('last_role_seen')).toBe('lastRoleSeen');
    expect(camelKey('y')).toBe('y');
    expect(camelKey('sha256')).toBe('sha256');
  });

  it('maps rows and leaves values untouched', () => {
    const when = new Date(0);
    expect(camelRow({ id: 'a', deleted_at: when, cost_at_lock: { food: 1 }, price: null })).toEqual({
      id: 'a',
      deletedAt: when,
      costAtLock: { food: 1 },
      price: null,
    });
    expect(camelRows([{ brand_id: 'x' }, { brand_id: 'y' }])).toEqual([{ brandId: 'x' }, { brandId: 'y' }]);
  });
});
