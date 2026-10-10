'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { can, ROLES, type Permission, type Role } from '@/lib/permissions';

export interface ClientWorkspace {
  id: string;
  name: string;
  code: string;
  color: string;
  onSolid: string;
  logoUrl: string | null;
  cards: number;
}

export type ClientBrand = ClientWorkspace;

export interface ClientSession {
  /** Brands the caller may use (new-card picker, filters). Cosmetic: the server re-checks every id. */
  brands: ClientBrand[];
  /** Active brand workspace (legacy S.activeBrand), or null. */
  workspace: ClientWorkspace | null;
  /** Menu Plans nav only for callers with the SSEM project in scope (D-06). */
  menusVisible: boolean;
  name: string;
  role: Role;
  /** Expanded permission list from the server on first paint (no hydration mismatch). Cosmetic only. */
  permissions: Permission[];
}

const Ctx = createContext<ClientSession | null>(null);

export function SessionProvider({ session, children }: { session: ClientSession; children: ReactNode }) {
  return <Ctx.Provider value={session}>{children}</Ctx.Provider>;
}

export function useSession(): ClientSession {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

/** Cosmetic permission check; the server enforces independently. */
export function usePerm(): (perm: Permission) => boolean {
  const s = useSession();
  return useMemo(() => {
    const set = new Set<Permission>(s.permissions);
    return (perm: Permission) => set.has(perm) && can(s.role, perm);
  }, [s]);
}

export function useRoleDef() {
  return ROLES[useSession().role];
}
