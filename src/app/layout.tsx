import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import '@/styles/legacy.css';
import { db } from '@/lib/db/client';
import { palette } from '@/lib/brand/palette';
import { pageCtx, pageSession } from '@/lib/page';
import { permissionsFor } from '@/lib/permissions';
import { Shell } from '@/components/shell/Shell';
import { SignOutCard } from '@/components/shell/SignOutCard';

export const metadata: Metadata = { title: 'ISFC Costing System' };
export const dynamic = 'force-dynamic'; // session-dependent shell; also keeps `next build` independent of secrets

export default async function RootLayout({ children }: { children: ReactNode }) {
  const s = await pageSession();

  let body: ReactNode;
  if (s.status === 'ok') {
    const ctx = await pageCtx();
    const counts = await db.query(
      'SELECT brand_id, count(*)::int AS n FROM recipe WHERE deleted_at IS NULL AND brand_id = ANY($1::text[]) GROUP BY brand_id',
      [[...ctx.scope.brandIds]],
    );
    const nOf = new Map<string, number>(counts.rows.map((r) => [r.brand_id as string, Number(r.n)]));
    const clientBrands = ctx.brands.map((x) => ({
      id: x.id,
      name: x.name,
      code: x.code,
      color: x.color || '#BB5E1E',
      onSolid: palette(x.color || '#BB5E1E', x.inkColor).onSolid,
      logoUrl: x.logoUrl,
      cards: nOf.get(x.id) ?? 0,
    }));
    body = (
      <Shell
        session={{
          name: s.user.name,
          role: s.user.role,
          permissions: permissionsFor(s.user.role),
          menusVisible: ctx.menusVisible,
          brands: clientBrands,
          workspace: clientBrands.find((x) => x.id === ctx.workspaceId) ?? null,
        }}
      >
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
