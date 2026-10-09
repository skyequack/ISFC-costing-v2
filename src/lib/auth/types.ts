import type { Role } from '../permissions';

export interface SessionUser {
  id: string; // app User.id
  clerkUserId: string;
  email: string | null;
  name: string;
  role: Role;
}

export type SessionResult =
  | { status: 'ok'; user: SessionUser }
  | { status: 'anonymous' }
  | { status: 'pending'; clerkUserId: string }
  | { status: 'inactive'; clerkUserId: string };
