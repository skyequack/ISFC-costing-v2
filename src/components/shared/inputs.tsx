'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';

interface CommitProps {
  value: string | number;
  onCommit: (v: string) => void;
  type?: 'text' | 'number';
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  step?: string;
  min?: string;
  title?: string;
  disabled?: boolean;
  readOnly?: boolean;
  id?: string;
  inputMode?: 'numeric' | 'decimal' | 'text';
  /** Enter moves to the next input of the same group (column entry), after committing this one. */
  navGroup?: string;
}

/**
 * Legacy `onchange` semantics: the typed text is committed when the field loses focus (or Enter), not on every keystroke.
 * Local text survives re-renders; when the committed value changes from outside it is shown again.
 */
export function CommitInput({ value, onCommit, type = 'text', navGroup, inputMode, ...rest }: CommitProps) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  return (
    <input
      {...rest}
      type={type}
      inputMode={inputMode ?? (type === 'number' ? 'decimal' : undefined)}
      enterKeyHint={navGroup ? 'next' : undefined}
      data-nav={navGroup}
      value={text}
      onFocus={(e) => {
        focused.current = true;
        if (type === 'number') e.target.select();
      }}
      onWheel={(e) => (e.target as HTMLInputElement).blur()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        focused.current = false;
        if (text !== String(value)) onCommit(text);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        const el = e.target as HTMLInputElement;
        if (navGroup) {
          const all = [...document.querySelectorAll<HTMLInputElement>(`input[data-nav="${navGroup}"]`)];
          const next = all[all.indexOf(el) + 1];
          if (next) {
            next.focus();
            return;
          }
        }
        el.blur();
      }}
    />
  );
}
