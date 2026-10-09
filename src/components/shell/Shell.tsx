'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useClerk } from '@clerk/nextjs';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { NAV, TITLES } from '@/lib/nav';
import { ROLES } from '@/lib/permissions';
import { ModalProvider } from '@/components/shared/Modal';
import { SessionProvider, usePerm, useSession, type ClientSession } from '@/components/shared/session-context';
import { ToastProvider } from '@/components/shared/Toast';
import { useStore } from '@/components/shared/form-store';
import { printStore } from './print-store';

/**
 * Real application shell, same structure as legacy (`#app > aside + main > header.top, #prthead, #view, #pvbar, #printcard`)
 * so the legacy CSS cascade is unchanged (docs/UI_PORT.md §1-2). Screens render inside `#view`.
 */
export function Shell({ session, children }: { session: ClientSession; children: ReactNode }) {
  const [titles, setTitles] = useState<{ title?: string; sub?: string }>({});
  return (
    <SessionProvider session={session}>
      <TitleCtx.Provider value={setTitles}>
        <ToastProvider>
          <ModalProvider>
            <div id="app">
              <Sidebar />
              <main>
                <Header override={titles} />
                <PrintHead />
                <div className="view" id="view">
                  {children}
                </div>
                <div id="pvbar"></div>
                <div id="printcard"></div>
              </main>
            </div>
          </ModalProvider>
        </ToastProvider>
      </TitleCtx.Provider>
    </SessionProvider>
  );
}

function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const route = pathname.split('/')[1] || 'dash';
  const can = usePerm();
  const { name, role, workspace, menusVisible } = useSession();
  const { signOut } = useClerk();
  const R = ROLES[role];

  const items = NAV.filter((n) => 'group' in n || !n.perm || can(n.perm)).filter(
    (n) => !('route' in n) || n.route !== 'plan' || menusVisible,
  );

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
        {workspace ? (
          <div
            className="bchip"
            style={{
              background: `linear-gradient(135deg,${workspace.color} 0%,${workspace.color}D9 100%)`,
              color: workspace.onSolid,
            }}
          >
            {workspace.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="bchip-lg" src={workspace.logoUrl} alt="" />
            )}
            <div>
              <span>Active brand</span>
              <b>{workspace.name}</b>
              <i>
                {workspace.code} {'·'} {workspace.cards} card{workspace.cards === 1 ? '' : 's'}
              </i>
            </div>
            <button type="button" onClick={() => router.push('/brands')} title="Switch brand">
              {'⇄'}
            </button>
          </div>
        ) : (
          <div className="bchip none" onClick={() => router.push('/brands')}>
            <div>
              <span>No brand selected</span>
              <b>Choose a workspace</b>
            </div>
            <button type="button">{'→'}</button>
          </div>
        )}
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

const TitleCtx = createContext<(t: { title?: string; sub?: string }) => void>(() => undefined);

/** Screens that set the header text at runtime (legacy sets #ttl / #tsub): <PageTitle title sub /> */
export function PageTitle({ title, sub }: { title?: string; sub?: string }) {
  const set = useContext(TitleCtx);
  useEffect(() => {
    set({ title, sub });
    return () => set({});
  }, [set, title, sub]);
  return null;
}

function Header({ override }: { override: { title?: string; sub?: string } }) {
  const pathname = usePathname();
  const route = pathname.split('/')[1] || 'dash';
  const [t0, s0] = TITLES[route] ?? ['', ''];
  const title = override.title ?? t0;
  const sub = override.sub ?? s0;
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

/** Legacy #prthead: the branded header that prints above a screen (hidden by print CSS on screen). */
function PrintHead() {
  const { workspace } = useSession();
  const pathname = usePathname();
  const ps = useStore(printStore);
  const [today, setToday] = useState('');
  useEffect(() => setToday(new Date().toLocaleDateString()), [pathname]);
  const route = pathname.split('/')[1] || 'dash';
  const title = (TITLES[route] ?? ['ISFC Costing System', ''])[0];
  return (
    <div id="prthead">
      {!ps.html && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/logo.png" alt="" />
          <div>
            <h2>{title}</h2>
            <div className="co">International Specialized Food Co.</div>
          </div>
          <div className="rt" suppressHydrationWarning>
            {workspace ? (
              <>
                {workspace.name}
                <br />
              </>
            ) : null}
            Printed {today}
          </div>
        </>
      )}
    </div>
  );
}

/** #pvbar (preview toolbar) and #printcard (the card being printed / previewed) + the body classes that drive print CSS. */
function PrintLayer() {
  const ps = useStore(printStore);
  useEffect(() => {
    document.body.classList.toggle('hascard', !!ps.html);
    document.body.classList.toggle('previewcard', !!ps.preview);
    return () => {
      document.body.classList.remove('hascard');
      document.body.classList.remove('previewcard');
    };
  }, [ps.html, ps.preview]);
  return (
    <>
      <div id="pvbar">
        {ps.preview && (
          <>
            <b>{ps.preview.title}</b>
            <button className="btn o" onClick={ps.preview.tab}>
              New tab
            </button>
            <button className="btn o" onClick={ps.preview.download}>
              Download
            </button>
            <button className="btn" onClick={ps.preview.done}>
              Done
            </button>
          </>
        )}
      </div>
      <div id="printcard" dangerouslySetInnerHTML={{ __html: ps.html }} />
    </>
  );
}
