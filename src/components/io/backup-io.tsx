'use client';

import { useRouter } from '@/components/shell/nav-progress';
import { useCallback } from 'react';
import { api, errText, isRateLimited } from '@/components/shared/api-client';
import { pausedNote, restoreCheckNote, restoreCommitNote } from '@/components/shared/rate-limit-text';
import { useModal } from '@/components/shared/Modal';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import type { RestoreStats } from '@/lib/services/backup';
import { RESTORE_SLICE_CHARS } from '@/lib/io-limits';
import { downloadFile, MAX_UPLOAD_BYTES, saveBlob } from './download';

const SLICE = RESTORE_SLICE_CHARS;

/** Full backup (assembled in the browser from the server's parts), CSV downloads and chunked restore (D-37). */
export function useBackupIO() {
  const toast = useToast();
  const modal = useModal();
  const router = useRouter();

  const exportBackup = useCallback(async () => {
    try {
      toast('Preparing the backup…');
      const core = await api<Record<string, unknown>>('GET', '/api/export/backup?part=core');
      const images = async (part: 'photos' | 'logos') => {
        const out: { code: string; data: string }[] = [];
        let offset: number | null = 0;
        while (offset !== null) {
          const r: { items: { code: string; data: string }[]; nextOffset: number | null } = await api(
            'GET',
            `/api/export/backup?part=${part}&offset=${offset}`,
          );
          out.push(...r.items);
          offset = r.nextOffset;
        }
        return out;
      };
      const stock = async (part: 'counts' | 'receipts') => {
        const out: unknown[] = [];
        let offset: number | null = 0;
        while (offset !== null) {
          const r: { items: unknown[]; nextOffset: number | null } = await api(
            'GET',
            `/api/export/backup?part=${part}&from=${core.stockFrom}&offset=${offset}`,
          );
          out.push(...r.items);
          offset = r.nextOffset;
        }
        return out;
      };
      const stockCounts = await stock('counts');
      const receipts = await stock('receipts');
      const photos = (await images('photos')).map((p) => ({ recipeCode: p.code, data: p.data }));
      const logos = (await images('logos')).map((l) => ({ brandCode: l.code, data: l.data }));
      const text = JSON.stringify({ ...core, stockCounts, receipts, photos, logos });
      saveBlob(
        `ISFC-costing-backup-${new Date().toISOString().slice(0, 10)}.json`,
        new Blob([text], { type: 'application/json' }),
      );
      toast('Backup downloaded – accounts are not part of it (they live in the sign-in service)');
    } catch (e) {
      toast(errText(e));
    }
  }, [toast]);

  const exportCsv = useCallback(
    async (kind: string) => {
      try {
        await downloadFile(`/api/export/${kind}`);
        toast('Download started');
      } catch (e) {
        toast(errText(e));
      }
    },
    [toast],
  );

  const restore = useCallback(
    async (file: File) => {
      if (file.size > MAX_UPLOAD_BYTES * 4) return toast('That file is too large to be a backup of this system');
      const fail = (message: string) =>
        modal.open({
          title: 'Could not restore',
          body: <div className="note r">{message}</div>,
          foot: (
            <button className="btn o" onClick={modal.close}>
              Close
            </button>
          ),
        });
      const checking = (pause?: string) =>
        modal.open({
          title: 'Checking the backup',
          body: (
            <>
              <p style={s('font-size:13.5px')}>
                Uploading <b>{file.name}</b> {'…'}
              </p>
              {pause && (
                <p role="status" style={s('font-size:13px;color:var(--mute);margin-top:8px')}>
                  {pause}
                </p>
              )}
            </>
          ),
          foot: <></>,
        });
      checking();
      // the one automatic retry (D-90): say so inside the dialog for the whole wait, then take the line away again
      let paused = false;
      const onWait = (seconds: number) => {
        paused = true;
        checking(pausedNote(seconds));
      };
      const resumed = () => {
        if (paused) checking();
        paused = false;
      };
      try {
        const text = await file.text();
        let probe: { format?: string; items?: unknown };
        try {
          probe = JSON.parse(text);
        } catch {
          return fail('That file is not a valid backup.');
        }
        if (probe.format !== 'isfc-backup')
          return fail('That file is not a backup made by this system (an old browser backup cannot be restored here).');
        const session = crypto.randomUUID();
        const total = Math.ceil(text.length / SLICE);
        for (let i = 0; i < total; i++) {
          await api(
            'POST',
            '/api/import/restore/chunk',
            { session, seq: i, data: text.slice(i * SLICE, (i + 1) * SLICE) },
            { onWait },
          );
          resumed();
        }
        const { stats } = await api<{ stats: RestoreStats }>(
          'POST',
          '/api/import/restore?mode=dry-run',
          { session, total, file: file.name },
          { onWait },
        );
        resumed();
        const review = (note?: string) =>
          modal.open({
            title: 'Restore from this backup?',
            body: (
              <>
                {note && (
                  <div className="note r" role="alert" style={s('margin:0 0 12px')}>
                    {note}
                  </div>
                )}
                <div className="note r" style={s('margin:0 0 12px')}>
                  <b>Restoring replaces what is in the system.</b> Cards the backup does not contain are moved to
                  deleted (you can restore them one by one); the activity log and price history are never touched.
                </div>
                <div className="tw">
                  <table>
                    <tbody>
                      <tr>
                        <td>Recipe cards</td>
                        <td className="n">
                          {stats.recipes.added} added {'·'} {stats.recipes.updated} updated {'·'}{' '}
                          <b>{stats.recipes.removed} removed</b>
                        </td>
                      </tr>
                      <tr>
                        <td>Ingredients</td>
                        <td className="n">
                          {stats.ingredients.added} added {'·'} {stats.ingredients.updated} updated {'·'}{' '}
                          {stats.ingredients.keptNotInBackup} kept (not in the backup)
                        </td>
                      </tr>
                      <tr>
                        <td>Brands</td>
                        <td className="n">
                          {stats.brands.added} added {'·'} {stats.brands.updated} updated
                        </td>
                      </tr>
                      <tr>
                        <td>Menus</td>
                        <td className="n">
                          {stats.menus.added} added {'·'} {stats.menus.updated} updated {'·'} {stats.menus.deactivated}{' '}
                          deactivated
                        </td>
                      </tr>
                      <tr>
                        <td>Headcounts / production figures</td>
                        <td className="n">
                          {stats.menuPax} / {stats.production}
                        </td>
                      </tr>
                      <tr>
                        <td>Stock counts / receipts</td>
                        <td className="n">
                          {stats.stockCounts == null && stats.receipts == null
                            ? 'left as they are (backup has none)'
                            : `${stats.stockCounts ?? 0} / ${stats.receipts ?? 0}${
                                stats.stockSkipped ? ` (${stats.stockSkipped} skipped: unknown site or ingredient)` : ''
                              }`}
                        </td>
                      </tr>
                      <tr>
                        <td>Pictures</td>
                        <td className="n">
                          {stats.photos == null
                            ? 'left as they are (backup has none)'
                            : `${stats.photos} photos, ${stats.logos ?? 0} logos`}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </>
            ),
            foot: (
              <>
                <button className="btn o" onClick={modal.close}>
                  Cancel
                </button>
                <button
                  className="btn d"
                  onClick={async () => {
                    try {
                      await api('POST', '/api/import/restore?mode=commit', { session, total, file: file.name });
                      modal.close();
                      toast('Backup restored');
                      router.refresh();
                    } catch (e) {
                      // refused for now: keep the dialog and the uploaded backup, the same button works again
                      if (isRateLimited(e)) review(restoreCommitNote(e.retryAfter));
                      else toast(errText(e));
                    }
                  }}
                >
                  Restore
                </button>
              </>
            ),
          });
        review();
      } catch (e) {
        fail(isRateLimited(e) ? restoreCheckNote(e.retryAfter) : errText(e));
      }
    },
    [modal, router, toast],
  );

  return { exportBackup, exportCsv, restore };
}
