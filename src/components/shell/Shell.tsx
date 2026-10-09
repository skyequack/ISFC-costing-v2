'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useClerk } from '@clerk/nextjs';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { NAV, TITLES } from '@/lib/nav';
import { ROLES } from '@/lib/permissions';
import { ModalProvider } from '@/components/shared/Modal';
import { SessionProvider, usePerm, useSession, type ClientSession } from '@/components/shared/session-context';
import { ToastProvider } from '@/components/shared/Toast';

/**
 * Real application shell, same structure as legacy (`#app > aside + main > header.top, #prthead, #view, #pvbar, #printcard`)
 * so the legacy CSS cascade is unchanged (docs/UI_PORT.md §1-2). Screens render inside `#view`.
 */
export function Shell({ session, children }: { session: ClientSession; children: ReactNode }) {
  return (
    <SessionProvider session={session}>
      <ToastProvider>
        <ModalProvider>
          <div id="app">
            <Sidebar />
            <main>
              <Header />
              <div id="prthead"></div>
              <div className="view" id="view">
                {children}
              </div>
              <div id="pvbar"></div>
              <div id="printcard"></div>
            </main>
          </div>
        </ModalProvider>
      </ToastProvider>
    </SessionProvider>
  );
}

function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const route = pathname.split('/')[1] || 'dash';
  const can = usePerm();
  const { name, role } = useSession();
  const { signOut } = useClerk();
  const R = ROLES[role];

  const items = NAV.filter((n) => 'group' in n || !n.perm || can(n.perm));

  return (
    <aside className="noprint">
      <div className="brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/assets/logo.png" alt="" />
        <div>
          <b>ISFC COSTING</b>
          <span>International Specialized Food Co.</span>
        </div>
      </div>
      <nav id="nav">
        <div className="bchip none" onClick={() => router.push('/brands')}>
          <div>
            <span>No brand selected</span>
            <b>Choose a workspace</b>
          </div>
          <button type="button">{'→'}</button>
        </div>
        <div className="authbar on">
          <span style={{ color: R.colour }}>
            {'●'} {name} {'·'} {R.label}
          </span>
          <button type="button" onClick={() => signOut({ redirectUrl: '/sign-in' })}>
            Sign out
          </button>
        </div>
        {items.map((n, i) => {
          if ('group' in n) {
            const next = items[i + 1];
            if (!next || 'group' in next) return null; // drop an empty group heading
            return (
              <div className="grp" key={`g-${n.group}`}>
                {n.group}
              </div>
            );
          }
          return (
            <button
              key={n.route}
              type="button"
              className={route === n.route ? 'on' : ''}
              onClick={() => router.push(`/${n.route}`)}
            >
              <span className="ic">{n.icon}</span>
              {n.label}
            </button>
          );
        })}
      </nav>
      <div className="uchip" id="uchip"></div>
      <div className="sidefoot">
        <div id="savedot">All changes saved</div>
        <div style={{ marginTop: 3 }} id="verline">
          v8.7
        </div>
      </div>
    </aside>
  );
}

function Header() {
  const pathname = usePathname();
  const route = pathname.split('/')[1] || 'dash';
  const [title, sub] = TITLES[route] ?? ['', ''];
  return (
    <header className="top">
      <div>
        <h1 id="ttl">{title}</h1>
        <div className="sub" id="tsub">
          {sub}
        </div>
      </div>
      <div className="spacer"></div>
      <div id="acts" style={{ display: 'flex', gap: 9 }}></div>
    </header>
  );
}

/** Screens put their header buttons into the `#acts` slot with <Acts>…</Acts> (legacy `#acts`). */
export function Acts({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => setEl(document.getElementById('acts')), []);
  return el ? createPortal(children, el) : null;
}
