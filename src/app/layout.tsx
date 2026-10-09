import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import '@/styles/legacy.css';
import { getSession } from '@/lib/auth/session';
import { permissionsFor } from '@/lib/permissions';
import { Shell } from '@/components/shell/Shell';
import { SignOutCard } from '@/components/shell/SignOutCard';

export const metadata: Metadata = { title: 'ISFC Costing System' };
export const dynamic = 'force-dynamic'; // session-dependent shell; also keeps `next build` independent of secrets

export default async function RootLayout({ children }: { children: ReactNode }) {
  const s = await getSession();

  let body: ReactNode;
  if (s.status === 'ok') {
    body = (
      <Shell session={{ name: s.user.name, role: s.user.role, permissions: permissionsFor(s.user.role) }}>
        {children}
      </Shell>
    );
  } else if (s.status === 'pending') {
    body = (
      <SignOutCard
        title="Account pending"
        message="Your account has no role yet. Ask the General Manager to assign you one, then sign in again."
      />
    );
  } else if (s.status === 'inactive') {
    body = (
      <SignOutCard title="Account suspended" message="This account has been suspended. Contact the General Manager." />
    );
  } else {
    body = children; // anonymous: middleware only lets /sign-in through
  }

  return (
    <html lang="en">
      <body>
        <ClerkProvider>{body}</ClerkProvider>
      </body>
    </html>
  );
}
