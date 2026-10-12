'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LONG_TOAST_MS, LONG_TOAST_PREFIX, RATE_WAIT_EVENT, WAITING_TOAST } from './rate-limit-text';

export interface ToastAction {
  label: string;
  fn: () => void;
}
/** `ms` overrides how long the toast stays (D-90: rate-limit messages stay longer so they can be read). */
type ToastFn = (message: string, action?: ToastAction, ms?: number) => void;

const Ctx = createContext<ToastFn | null>(null);

/** One toast (legacy toast(), 2.2 s; 8 s when it carries an action button). Markup/classes identical to legacy. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ message: string; action?: ToastAction; on: boolean }>({
    message: '',
    on: false,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback<ToastFn>((message, action, ms) => {
    setState({ message, action, on: true });
    clearTimeout(timer.current);
    const long = message.startsWith(LONG_TOAST_PREFIX) ? LONG_TOAST_MS : 2200;
    timer.current = setTimeout(() => setState((s) => ({ ...s, on: false })), ms ?? (action ? 8000 : long));
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);
  // the API client waits for its one automatic retry (D-90): say so, or the screen looks frozen
  useEffect(() => {
    const onWait = () => toast(WAITING_TOAST, undefined, 6000);
    window.addEventListener(RATE_WAIT_EVENT, onWait);
    return () => window.removeEventListener(RATE_WAIT_EVENT, onWait);
  }, [toast]);
  const value = useMemo(() => toast, [toast]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className={`toast${state.on ? ' on' : ''}`} id="toast" role="status" aria-live="polite">
        <span>{state.message}</span>
        {state.action && (
          <button
            className="tbtn"
            onClick={() => {
              setState((s) => ({ ...s, on: false }));
              state.action?.fn();
            }}
          >
            {state.action.label}
          </button>
        )}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastFn {
  const t = useContext(Ctx);
  if (!t) throw new Error('useToast outside ToastProvider');
  return t;
}
