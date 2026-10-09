'use client';

import { cloneElement, type ReactElement } from 'react';
import type { Permission } from '@/lib/permissions';
import { usePerm } from './session-context';

type Child = ReactElement<{ className?: string; style?: React.CSSProperties; title?: string; disabled?: boolean }>;

/**
 * Reproduces legacy enforce() (legacy/app.html 621-628) for a single element:
 * no permission -> BUTTON/LABEL are hidden; anything else is disabled, gets `.locked` and title "Locked for your role".
 * Cosmetic only — the server enforces permissions.
 */
export function Perm({ perm, children }: { perm: Permission; children: Child }) {
  const can = usePerm();
  if (can(perm)) return children;
  const tag = typeof children.type === 'string' ? children.type.toUpperCase() : '';
  if (tag === 'BUTTON' || tag === 'LABEL') {
    return cloneElement(children, { style: { ...children.props.style, display: 'none' } });
  }
  return cloneElement(children, {
    disabled: true,
    className: [children.props.className, 'locked'].filter(Boolean).join(' '),
    title: 'Locked for your role',
  });
}
