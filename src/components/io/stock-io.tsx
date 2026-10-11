'use client';

import { useCallback } from 'react';
import { api, errText } from '@/components/shared/api-client';
import { useModal } from '@/components/shared/Modal';
import { useToast } from '@/components/shared/Toast';
import { useRouter } from '@/components/shell/nav-progress';
import { s } from '@/components/ui';
import { parseStockRows, STOCK_TPL_HEAD } from '@/lib/import/stock';
import type { StockImportPlan } from '@/lib/services/import-stock';
import type { StockGrid } from '@/lib/services/stock';
import { readTable } from '@/lib/xlsx/read';
import { readFileBytes, saveCsv } from './download';

/** Template and upload for the Stock screen (D-73, slice 2c): the file is checked first, then loaded whole or not at all. */
export function useStockIO(grid: Pick<StockGrid, 'site' | 'date' | 'kind' | 'rows'>) {
  const modal = useModal();
  const toast = useToast();
  const router = useRouter();
  const isCount = grid.kind === 'count';
  const noun = isCount ? 'counts' : 'receipts';

  const template = useCallback(() => {
    // receipts are added, never replaced, so their template starts empty (pre-filled values would be loaded again as new deliveries)
    const rows = grid.rows.map((r) => [grid.site, grid.date, r.code, r.name, r.uom, isCount ? (r.qty ?? '') : '']);
    saveCsv(`ISFC-stock-${noun}-${grid.site}-${grid.date}.csv`, [STOCK_TPL_HEAD, ...rows]);
    toast('Template downloaded');
  }, [grid.rows, grid.site, grid.date, isCount, noun, toast]);

  const upload = useCallback(() => {
    function back(message: string, title = 'Could not read that file') {
      modal.open({
        title,
        body: <div className="note r">{message}</div>,
        foot: (
          <button className="btn o" onClick={upload}>
            Back
          </button>
        ),
      });
    }

    async function pickFile(file: File | undefined) {
      if (!file) return;
      modal.open({
        title: 'Reading the file',
        body: (
          <p style={s('font-size:13.5px')}>
            Opening <b>{file.name}</b> {'…'}
          </p>
        ),
        foot: <></>,
      });
      let table: unknown[][];
      try {
        table = await readTable({ name: file.name, bytes: await readFileBytes(file) });
      } catch (e) {
        return back(e instanceof Error ? e.message : 'Unreadable file.');
      }
      if (!table.length) return back('That file has no rows.', 'Nothing to load');
      const parsed = parseStockRows(table, { site: grid.site, date: grid.date });
      if (!parsed.rows.length)
        return back(
          parsed.rejected.length ? parsed.rejected.slice(0, 5).join('\n') : 'No rows with a quantity were found.',
          'Nothing to load',
        );
      try {
        const plan = await api<StockImportPlan>('POST', '/api/stock/import?mode=dry-run', {
          kind: grid.kind,
          rows: parsed.rows,
          file: file.name,
        });
        review(file.name, parsed, plan);
      } catch (e) {
        back(errText(e));
      }
    }

    /** Deliveries from a file cannot be edited afterwards, so the result stays on screen with a way to take them back. */
    function loaded(n: number, hash: string) {
      async function undo() {
        try {
          const r = await api<{ removed: number }>('POST', '/api/stock/import?mode=undo', { hash });
          modal.close();
          toast(`${r.removed} deliveries removed`);
          router.refresh();
        } catch (e) {
          toast(errText(e));
        }
      }
      modal.open({
        title: 'Receipts loaded',
        body: (
          <p style={s('font-size:13.5px')}>
            <b>{n}</b> deliver{n === 1 ? 'y was' : 'ies were'} loaded. Deliveries from a file cannot be edited
            afterwards; if this was the wrong file, undo it now.
          </p>
        ),
        foot: (
          <>
            <button className="btn o" onClick={undo}>
              Undo this upload
            </button>
            <button className="btn" onClick={modal.close}>
              Done
            </button>
          </>
        ),
      });
    }

    function review(file: string, parsed: ReturnType<typeof parseStockRows>, plan: StockImportPlan) {
      const problems = [...parsed.rejected, ...plan.blocked.map((b) => `Row ${b.line} ${b.code}: ${b.reason}`)];
      const nProblems = parsed.rejected.length + plan.counts.blocked;
      const writes = plan.counts.add + plan.counts.update;
      const stop = nProblems > 0 || plan.alreadyImported;

      async function commit() {
        try {
          const r = await api<{ added: number; updated: number }>('POST', '/api/stock/import?mode=commit', {
            kind: grid.kind,
            rows: parsed.rows,
            file,
            hash: plan.hash,
          });
          router.refresh();
          if (isCount) {
            modal.close();
            toast(`${r.added} counts added · ${r.updated} changed`);
          } else loaded(r.added, plan.hash);
        } catch (e) {
          toast(errText(e));
        }
      }

      modal.open({
        title: `Check the ${isCount ? 'stock counts' : 'receipts'} before loading`,
        body: (
          <>
            <div className="row r3" style={s('margin-bottom:14px')}>
              <div className="kpi g" style={s('border-top-width:3px')}>
                <div className="k">{isCount ? 'New' : 'Deliveries'}</div>
                <div className="v">{plan.counts.add}</div>
              </div>
              {isCount && (
                <>
                  <div className="kpi" style={s('border-top-width:3px')}>
                    <div className="k">Changed</div>
                    <div className="v">{plan.counts.update}</div>
                  </div>
                  <div className="kpi" style={s('border-top-width:3px')}>
                    <div className="k">No change</div>
                    <div className="v">{plan.counts.same}</div>
                  </div>
                </>
              )}
            </div>
            <p style={s('font-size:13px;margin-bottom:12px')}>
              <b>{file}</b> {'·'} {plan.total} row{plan.total === 1 ? '' : 's'} read {'·'} {plan.sites.join(', ')} {'·'}{' '}
              {plan.dates[0]}
              {plan.dates.length > 1 ? ` to ${plan.dates.at(-1)}` : ''}
            </p>
            {parsed.blank > 0 && (
              <div className="note" style={s('margin:0 0 10px')}>
                {parsed.blank} row{parsed.blank === 1 ? ' has' : 's have'} no quantity. Those were not counted, so they
                are left out and nothing is stored for them.
              </div>
            )}
            {plan.alreadyImported && (
              <div className="note r" style={s('margin:0 0 10px')}>
                <b>This file has already been loaded.</b> Loading it again would double every delivery.
              </div>
            )}
            {nProblems > 0 && (
              <div className="note r" style={s('margin:0 0 10px')}>
                <b>
                  {nProblems} row{nProblems === 1 ? '' : 's'} cannot be loaded
                </b>
                <div style={s('margin-top:5px;font-size:11.5px;max-height:110px;overflow:auto')}>
                  {problems.slice(0, 15).map((x, i) => (
                    <div key={i}>{x}</div>
                  ))}
                </div>
                <div style={s('margin-top:6px;font-size:11.5px')}>
                  The file is loaded whole or not at all. Fix these rows and choose the file again.
                </div>
              </div>
            )}
            {plan.sample.length > 0 && (
              <>
                <h3
                  style={s(
                    'margin:14px 0 8px;font-size:12.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--org-dk)',
                  )}
                >
                  {isCount ? 'What changes' : 'What is delivered'}
                </h3>
                <div className="tw" style={s('max-height:210px;overflow:auto')}>
                  <table>
                    <thead>
                      <tr>
                        <th style={s('width:110px')}>Code</th>
                        <th>Item</th>
                        <th style={s('width:80px')}>Site</th>
                        <th style={s('width:96px')}>Date</th>
                        {isCount && (
                          <th className="n" style={s('width:80px')}>
                            Now
                          </th>
                        )}
                        <th className="n" style={s('width:90px')}>
                          {isCount ? 'Becomes' : 'Delivered'}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.sample.map((p) => (
                        <tr key={`${p.site}|${p.date}|${p.code}`}>
                          <td className="mono" style={s('color:var(--org-dk);font-weight:700')}>
                            {p.code}
                          </td>
                          <td>{p.name}</td>
                          <td>{p.site}</td>
                          <td>{p.date}</td>
                          {isCount && (
                            <td className="n">
                              {p.old == null ? <span style={s('color:var(--mute)')}>none</span> : p.old}
                            </td>
                          )}
                          <td className="n" style={s('font-weight:600')}>
                            {p.qty}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {writes > plan.sample.length && (
                  <div style={s('font-size:11.5px;color:var(--mute);margin-top:6px')}>
                    Showing the first {plan.sample.length} of {writes}.
                  </div>
                )}
              </>
            )}
          </>
        ),
        foot: (
          <>
            <button className="btn o" onClick={upload}>
              Back
            </button>
            <button className="btn" disabled={stop || !writes} onClick={commit}>
              Load {writes} row{writes === 1 ? '' : 's'}
            </button>
          </>
        ),
      });
    }

    modal.open({
      title: `Upload ${isCount ? 'stock counts' : 'receipts'}`,
      body: (
        <>
          <p style={s('font-size:13px;color:var(--mute);margin-bottom:6px')}>
            Excel or CSV. Columns are found by their heading, in any order {'–'} these names all work:
          </p>
          <p
            className="mono"
            style={s('background:var(--org-xl);padding:10px;border-radius:7px;margin:0 0 10px;font-size:11.5px')}
          >
            Code {'·'} {isCount ? 'Quantity or Counted' : 'Quantity or Delivered'} {'·'} Site (optional) {'·'} Date
            (optional, YYYY-MM-DD)
          </p>
          <p style={s('font-size:12.5px;color:var(--mute)')}>
            A row without a Site or Date uses the ones on the screen ({grid.site}, {grid.date}).{' '}
            {isCount
              ? 'A row with no quantity is not counted and is left alone; a 0 means counted and empty.'
              : 'Each row is one delivery; the same file cannot be loaded twice.'}{' '}
            You see everything that will change before it is written, and the file is loaded whole or not at all.
          </p>
          <div style={s('display:flex;gap:9px;margin-top:16px')}>
            <label className="btn" style={s('flex:1;justify-content:center')}>
              Choose a file
              <input
                type="file"
                accept=".csv,.txt,.tsv,.xlsx,.xlsm"
                style={s('display:none')}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  void pickFile(file);
                }}
              />
            </label>
          </div>
        </>
      ),
      foot: (
        <button className="btn o" onClick={modal.close}>
          Cancel
        </button>
      ),
    });
  }, [grid.date, grid.kind, grid.site, isCount, modal, router, toast]);

  return { template, upload };
}
