'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export interface ToastAction {
  label: string;
  fn: () => void;
}
type ToastFn = (message: string, action?: ToastAction) => void;

const Ctx = createContext<ToastFn | null>(null);

/** One toast (legacy toast(), 2.2 s; 8 s when it carries an action button). Markup/classes identical to legacy. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ message: string; action?: ToastAction; on: boolean }>({
    message: '',
    on: false,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback<ToastFn>((message, action) => {
    setState({ message, action, on: true });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState((s) => ({ ...s, on: false })), action ? 8000 : 2200);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);
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
