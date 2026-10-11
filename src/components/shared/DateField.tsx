'use client';

import { useEffect, useRef, useState } from 'react';

/** Wait this long after the last keystroke before a typed date is applied (a pick, Enter or leaving the field applies it at once). */
export const DATE_COMMIT_MS = 700;

/** A full date in a believable year (typing 2026 passes through 0002, 0020 and 0202), or blank when blank is allowed. */
const committable = (v: string, allowBlank: boolean) =>
  v === '' ? allowBlank : /^\d{4}-\d{2}-\d{2}$/.test(v) && +v.slice(0, 4) >= 1900 && +v.slice(0, 4) <= 2200;

/**
 * Date field that keeps what is typed and only reports a date once it is complete, so typing never fires a request per
 * keystroke (D-65 dashboard filter, D-73 stock date). Blank means "no date" unless `allowBlank` is false.
 */
export function DateField({
  value,
  label,
  min,
  max,
  allowBlank = true,
  onCommit,
}: {
  value: string;
  label: string;
  min?: string;
  max?: string;
  allowBlank?: boolean;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const commit = (v: string) => {
    clearTimeout(timer.current);
    if (v !== value && committable(v, allowBlank)) onCommit(v);
  };
  return (
    <input
      type="date"
      value={draft}
      min={min}
      max={max}
      aria-label={label}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => commit(v), DATE_COMMIT_MS);
      }}
      onBlur={() => commit(draft)}
      onKeyDown={(e) => e.key === 'Enter' && commit(draft)}
    />
  );
}
