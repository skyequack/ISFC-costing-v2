'use client';

import { useToast } from '@/components/shared/Toast';

/** Recipe export / template / upload (Phase 6 — real implementation follows). */
export function useRecipeIO() {
  const toast = useToast();
  const later = () => toast('Arrives with Phase 6');
  return { exportAll: (_fmt: 'xlsx' | 'csv') => later(), templateMenu: later, upload: later };
}
