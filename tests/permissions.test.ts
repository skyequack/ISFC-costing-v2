import { describe, expect, it } from 'vitest';
import { can, isRole, PERMISSIONS, permissionsFor, ROLE_KEYS, ROLES } from '@/lib/permissions';

const PHASE8: readonly string[] = ['clients.edit', 'stock.edit', 'stock.view'];

describe('permissions', () => {
  it('gm has everything, including GM-only perms', () => {
    for (const p of PERMISSIONS) expect(can('gm', p)).toBe(true);
  });

  it('GM-only perms are held by no other role (D-16)', () => {
    for (const r of ROLE_KEYS.filter((k) => k !== 'gm'))
      for (const p of ['users.manage', 'data.admin', 'brands.edit'] as const) expect(can(r, p)).toBe(false);
  });

  it('menu.edit is gm + cc only (D-16)', () => {
    expect(ROLE_KEYS.filter((r) => can(r, 'menu.edit')).sort()).toEqual(['cc', 'gm']);
  });

  it('legacy matrix is preserved verbatim (the Phase 8 permissions are added on top, D-72)', () => {
    const legacy = (r: keyof typeof ROLES) => ROLES[r].perms.filter((p) => !PHASE8.includes(p));
    expect(legacy('fin')).toEqual(['recipe.price', 'items.edit', 'settings.edit', 'export', 'audit.view']);
    expect(legacy('chef')).toEqual(['recipe.create', 'recipe.edit', 'recipe.lock', 'export']);
    expect(legacy('cook')).toEqual(['recipe.create', 'recipe.edit', 'export']);
    expect(legacy('viewer')).toEqual(['export']);
    expect(can('cc', 'settings.edit')).toBe(false);
  });

  it('stock.edit is every role except the viewer; every role can see the stock screen (D-72)', () => {
    expect(ROLE_KEYS.filter((r) => can(r, 'stock.edit')).sort()).toEqual(['cc', 'chef', 'cook', 'fin', 'gm']);
    for (const r of ROLE_KEYS) expect(can(r, 'stock.view'), r).toBe(true);
  });

  it('missing/unknown role has no permissions (never viewer, D-22)', () => {
    expect(can(null, 'export')).toBe(false);
    expect(can(undefined, 'export')).toBe(false);
    expect(can('admin' as never, 'export')).toBe(false);
    expect(isRole('admin')).toBe(false);
  });

  it('permissionsFor lists expanded gm perms', () => {
    expect(permissionsFor('gm')).toEqual([...PERMISSIONS]);
    expect(permissionsFor('viewer')).toEqual(['export', 'stock.view']);
  });
});
