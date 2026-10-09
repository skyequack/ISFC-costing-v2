'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export interface ModalSpec {
  title: string;
  body: ReactNode;
  /** Footer content; defaults to a Close button like legacy modal(). */
  foot?: ReactNode;
}
interface ModalApi {
  open: (spec: ModalSpec) => void;
  close: () => void;
}

const Ctx = createContext<ModalApi | null>(null);

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * One dialog (legacy modal()/closeModal()). Same markup `.modal.on > .box > h3/.bd/.ft`; Esc or backdrop click closes.
 * Accessibility additions with no pixel change: role=dialog, aria-modal, focus trap, focus return.
 */
export function ModalProvider({ children }: { children: ReactNode }) {
  const [spec, setSpec] = useState<ModalSpec | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const close = useCallback(() => setSpec(null), []);
  const open = useCallback((s: ModalSpec) => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSpec(s);
  }, []);

  useEffect(() => {
    if (!spec) return;
    const el = box.current;
    el?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return close();
      if (e.key !== 'Tab' || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      returnTo.current?.focus();
    };
  }, [spec, close]);

  const api = useMemo(() => ({ open, close }), [open, close]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        className={`modal${spec ? ' on' : ''}`}
        id="modal"
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div className="box" ref={box} role="dialog" aria-modal="true" aria-labelledby="mtitle">
          <h3 id="mtitle">{spec?.title}</h3>
          <div className="bd" id="mbody">
            {spec?.body}
          </div>
          <div className="ft" id="mfoot">
            {spec &&
              (spec.foot ?? (
                <button className="btn o" onClick={close}>
                  Close
                </button>
              ))}
          </div>
        </div>
      </div>
    </Ctx.Provider>
  );
}

export function useModal(): ModalApi {
  const m = useContext(Ctx);
  if (!m) throw new Error('useModal outside ModalProvider');
  return m;
}
