'use client';

import { csvLine } from '@/lib/csv';
import { xlsxBytes } from '@/lib/xlsx/write';
import { apiErrorOf, fetchRetry } from '@/components/shared/api-client';
import { downloadText } from '@/components/shared/print-doc';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function saveBlob(name: string, blob: Blob): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

/** CSV with BOM (legacy template files) — formula starters neutralised by csvLine (D-36). */
export function saveCsv(name: string, rows: unknown[][], bom = true): void {
  downloadText(name, (bom ? '﻿' : '') + rows.map((r) => csvLine(r)).join('\n'), 'text/csv;charset=utf-8');
}

export function saveXlsx(name: string, rows: unknown[][]): void {
  saveBlob(
    name,
    new Blob([xlsxBytes(rows) as BlobPart], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
  );
}

/**
 * Download a file the server builds (CSV or Excel rows) through fetch instead of navigating to it (D-90): a refusal such as
 * "too many tries" becomes a message the caller can show, not a page of JSON that replaces the screen. One automatic retry
 * on a short 429, like every other call. Throws ClientApiError.
 */
export async function downloadFile(url: string, fallbackName = 'ISFC-export.csv'): Promise<void> {
  const res = await fetchRetry(url, { cache: 'no-store' });
  if (!res.ok) throw await apiErrorOf(res, url, () => 'Download failed');
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  saveBlob(name, await res.blob());
}

export async function readFileBytes(file: File): Promise<Uint8Array> {
  if (file.size > MAX_UPLOAD_BYTES)
    throw new Error(`That file is over ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB - split it and upload in parts.`);
  return new Uint8Array(await file.arrayBuffer());
}
