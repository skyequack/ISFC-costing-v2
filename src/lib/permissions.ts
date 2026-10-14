/**
 * Central permission model. Roles are ported verbatim from legacy ROLES (legacy/app.html 552-574)
 * plus the new permissions in DECISIONS D-05/D-16: menu.edit, users.manage, data.admin, brands.edit.
 * Client use of can() is cosmetic only; the server enforces via withAuth.
 */
export const PERMISSIONS = [
  'recipe.create',
  'recipe.edit',
  'recipe.delete',
  'recipe.price',
  'recipe.lock',
  'recipe.unlock',
  'items.edit',
  'conv.edit',
  'settings.edit',
  'export',
  'audit.view',
  'menu.edit',
  'users.manage',
  'data.admin',
  'brands.edit',
  'units.edit',
  'clients.edit',
  'stock.edit',
  'stock.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_KEYS = ['gm', 'cc', 'fin', 'chef', 'cook', 'viewer'] as const;
export type Role = (typeof ROLE_KEYS)[number];

export interface RoleDef {
  label: string;
  rank: number;
  colour: string;
  note: string;
  perms: readonly (Permission | '*')[];
}

export const ROLES: Record<Role, RoleDef> = {
  gm: {
    label: 'General Manager',
    rank: 4,
    colour: 'var(--org-dk)',
    note: 'Full control including cost settings, brands, users and restores.',
    perms: ['*'],
  },
  cc: {
    label: 'Cost Controller',
    rank: 3,
    colour: 'var(--org)',
    note: 'Prices, recipes and deletions. Cannot change global cost settings or users.',
    perms: [
      'recipe.create',
      'recipe.edit',
      'recipe.delete',
      'recipe.price',
      'recipe.lock',
      'recipe.unlock',
      'items.edit',
      'conv.edit',
      'export',
      'audit.view',
      'menu.edit',
      'clients.edit',
      'stock.edit',
      'stock.view',
    ],
  },
  fin: {
    label: 'Finance',
    rank: 3,
    colour: 'var(--fin)',
    note: 'Owns the money side: purchase prices from invoices, sales prices, and the cost percentages. Does not write recipes.',
    perms: ['recipe.price', 'items.edit', 'settings.edit', 'export', 'audit.view', 'stock.edit', 'stock.view'],
  },
  chef: {
    label: 'Head Chef',
    rank: 2,
    colour: 'var(--grn-dk)',
    note: 'Builds and edits recipe cards, and submits them for approval. Cannot price, delete or reopen an approved card.',
    perms: ['recipe.create', 'recipe.edit', 'recipe.lock', 'export', 'stock.edit', 'stock.view'],
  },
  cook: {
    label: 'Chef',
    rank: 2,
    colour: 'var(--chef)',
    note: 'Writes and edits recipe cards. Cannot approve one, set a price, or delete anything.',
    perms: ['recipe.create', 'recipe.edit', 'export', 'stock.edit', 'stock.view'],
  },
  viewer: {
    label: 'Viewer',
    rank: 1,
    colour: 'var(--mute)',
    note: 'Read and print only. Nothing can be changed.',
    perms: ['export', 'stock.view'],
  },
};

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLE_KEYS as readonly string[]).includes(v);
}

/** Unknown/missing role has NO permissions (D-22: never falls back to viewer). */
export function can(role: Role | null | undefined, perm: Permission): boolean {
  if (!role || !isRole(role)) return false;
  const perms = ROLES[role].perms;
  return perms.includes('*') || perms.includes(perm);
}

export function permissionsFor(role: Role): Permission[] {
  return PERMISSIONS.filter((p) => can(role, p));
}
