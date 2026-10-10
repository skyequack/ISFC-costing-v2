'use client';

import { useRouter as useNextRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react';

/**
 * Navigation progress: a thin bar at the top while a page or a refresh is loading.
 * It is on while (a) a navigation started through useRouter() below is still in flight (a React transition), or
 * (b) a route skeleton (loading.tsx -> <SkeletonMark/>) is on screen, i.e. the real page has not replaced it yet.
 * No library and no per-page code: pages never know about it.
 */
interface NavCtx {
  /** wrap a navigation so the bar covers it */
  run: (fn: () => void) => void;
  /** a route skeleton mounted / unmounted */
  skeleton: (on: boolean) => void;
}
const Ctx = createContext<NavCtx | null>(null);

const SHOW_AFTER_MS = 120; // instant navigations never flash the bar
const FINISH_MS = 260;

type Phase = 'idle' | 'run' | 'finish';

export function NavProgressProvider({ children }: { children: ReactNode }) {
  const [pending, startTransition] = useTransition();
  const [skeletons, setSkeletons] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const active = pending || skeletons > 0;
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const endTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (active) {
      clearTimeout(endTimer.current);
      if (phase === 'idle') showTimer.current = setTimeout(() => setPhase('run'), SHOW_AFTER_MS);
      else if (phase === 'finish') setPhase('run');
      return () => clearTimeout(showTimer.current);
    }
    clearTimeout(showTimer.current);
    if (phase === 'run') {
      setPhase('finish');
      endTimer.current = setTimeout(() => setPhase('idle'), FINISH_MS);
    }
    return undefined;
  }, [active, phase]);
  useEffect(() => () => (clearTimeout(showTimer.current), clearTimeout(endTimer.current)), []);

  const run = useCallback((fn: () => void) => startTransition(fn), []);
  const skeleton = useCallback((on: boolean) => setSkeletons((n) => Math.max(0, n + (on ? 1 : -1))), []);
  const value = useMemo(() => ({ run, skeleton }), [run, skeleton]);

  return (
    <Ctx.Provider value={value}>
      <div
        className={`navbar ${phase}`}
        role="progressbar"
        aria-label="Loading"
        aria-hidden={phase === 'idle'}
        aria-busy={phase === 'run'}
      />
      {children}
    </Ctx.Provider>
  );
}

/**
 * Drop-in for next/navigation's useRouter: push / replace / refresh run inside a transition the bar can see.
 * Without the provider (tests of a single component) it is the plain router.
 */
export function useRouter() {
  const router = useNextRouter();
  const nav = useContext(Ctx);
  return useMemo(() => {
    if (!nav) return router;
    return {
      ...router,
      push: (href: string, opts?: Parameters<typeof router.push>[1]) => nav.run(() => router.push(href, opts)),
      replace: (href: string, opts?: Parameters<typeof router.replace>[1]) => nav.run(() => router.replace(href, opts)),
      refresh: () => nav.run(() => router.refresh()),
    };
  }, [router, nav]);
}

/** Rendered by every route skeleton: keeps the bar running until the skeleton is replaced by the real page. */
export function SkeletonMark() {
  const nav = useContext(Ctx);
  useEffect(() => {
    nav?.skeleton(true);
    return () => nav?.skeleton(false);
  }, [nav]);
  return null;
}
