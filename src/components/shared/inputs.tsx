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
}

/**
 * Legacy `onchange` semantics: the typed text is committed when the field loses focus (or Enter), not on every keystroke.
 * Local text survives re-renders; when the committed value changes from outside it is shown again.
 */
export function CommitInput({ value, onCommit, type = 'text', ...rest }: CommitProps) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  return (
    <input
      {...rest}
      type={type}
      value={text}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        focused.current = false;
        if (text !== String(value)) onCommit(text);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
