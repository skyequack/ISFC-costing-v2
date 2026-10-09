'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { can, ROLES, type Permission, type Role } from '@/lib/permissions';

export interface ClientSession {
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
