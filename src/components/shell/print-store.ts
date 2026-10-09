'use client';

import { createStore } from '@/components/shared/form-store';

/**
 * What the shell's #printcard / #pvbar hold (legacy syncPrintTarget / previewCard). While `html` is set the body carries
 * `hascard` (so the browser prints only the card); while `preview` is set it carries `previewcard` (card shown full width).
 */
export interface PrintState {
  html: string;
  preview: { title: string; tab: () => void; download: () => void; done: () => void } | null;
}

export const printStore = createStore<PrintState>({ html: '', preview: null });
