'use client';

import { useToast } from '@/components/shared/Toast';

/** Price-list template menu + upload (legacy templateMenu / importItems). Filled in with Phase 6 (import/export). */
export function useItemIO(_brands: { id: string; name: string; code: string }[]) {
  const toast = useToast();
  return {
    template: () => toast('Template download arrives with Phase 6'),
    upload: () => toast('Upload arrives with Phase 6'),
  };
}
