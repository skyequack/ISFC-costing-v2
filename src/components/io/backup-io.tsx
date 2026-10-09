'use client';

import { useToast } from '@/components/shared/Toast';

/** Backup / restore / CSV exports (Phase 6 — real implementation follows). */
export function useBackupIO() {
  const toast = useToast();
  return {
    exportBackup: () => toast('Backup arrives with Phase 6'),
    exportCsv: (kind: string) => {
      window.location.href = `/api/export/${kind}`;
    },
    restore: (_f: File) => toast('Restore arrives with Phase 6'),
  };
}
