'use client';

import { useRouter } from '@/components/shell/nav-progress';
import { useCallback } from 'react';
import { api, errText } from '@/components/shared/api-client';
import { createStore, useStore, type Store } from '@/components/shared/form-store';
import { useModal } from '@/components/shared/Modal';
import { useSession } from '@/components/shared/session-context';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { PRICE_VARIANCE_THRESHOLD } from '@/domain/ingredients';
import { cur } from '@/lib/format';
import { parseItemRows, TPL_HEAD, tplRows } from '@/lib/import/items';
import { readTable } from '@/lib/xlsx/read';
import type { ItemImportIn, ItemImportPlan, ItemPlanRow } from '@/lib/services/import-items';
import { ITEM_IMPORT_PART } from '@/lib/io-limits';
import { downloadFile, readFileBytes, saveCsv } from './download';

type Brand = { id: string; name: string; code: string };

const PART = ITEM_IMPORT_PART;

/** Price-list template menu + upload (legacy templateMenu 4563 / importItems 4519 / doImportItems 4660). */
export function useItemIO(brandsIn: Brand[]) {
  const modal = useModal();
  const toast = useToast();
  const router = useRouter();
  const { workspace, brands: sessionBrands } = useSession();
  const brands: Brand[] = brandsIn.length ? brandsIn : sessionBrands;

  const template = useCallback(() => {
    async function dl(kind: 'blank' | 'brand' | 'all') {
      try {
        if (kind === 'blank') saveCsv('ISFC-price-list-template.csv', [TPL_HEAD, ...tplRows()], false);
        else {
          const q = kind === 'brand' && workspace ? `?brand=${encodeURIComponent(workspace.id)}` : '?brand=*';
          await downloadFile(
            `/api/export/price-template${q}`,
            kind === 'brand' && workspace ? `ISFC-${workspace.code}-price-list.csv` : 'ISFC-all-ingredients.csv',
          );
        }
        toast('Template downloaded');
      } catch (e) {
        toast(errText(e));
      }
    }
    modal.open({
      title: 'Download a price list template',
      body: (
        <>
          <p style={s('font-size:13px;color:var(--mute);margin-bottom:14px')}>
            Fill it in, then use <b>Upload price list</b> to load it back.
          </p>
          <div style={s('display:flex;flex-direction:column;gap:9px')}>
            <button className="btn" style={s('justify-content:center')} onClick={() => dl('blank')}>
              Blank template with example rows
            </button>
            {workspace && (
              <button className="btn o" style={s('justify-content:center')} onClick={() => dl('brand')}>
                {workspace.name} {'–'} current items to edit
              </button>
            )}
            <button className="btn o" style={s('justify-content:center')} onClick={() => dl('all')}>
              Every ingredient to edit
            </button>
          </div>
          <div className="note" style={s('margin:16px 0 0')}>
            Editing an exported list and uploading it back is the safest way to reprice in bulk {'–'} the codes already
            match, so nothing is duplicated.
          </div>
        </>
      ),
    });
  }, [modal, toast, workspace]);

  const upload = useCallback(() => {
    const st = createStore({ brandId: workspace?.id ?? '', grant: true });

    async function pickFile(file: File | undefined) {
      if (!file) return;
      const { brandId, grant } = st.get();
      modal.open({
        title: 'Reading the file',
        body: (
          <p style={s('font-size:13.5px')}>
            Opening <b>{file.name}</b> {'…'}
          </p>
        ),
        foot: <></>,
      });
      let rows: unknown[][];
      try {
        rows = await readTable({ name: file.name, bytes: await readFileBytes(file) });
      } catch (e) {
        return back(e instanceof Error ? e.message : 'Unreadable file.');
      }
      if (!rows.length) return back('That file has no rows.', 'Nothing to load');
      const parsed = parseItemRows(rows);
      if (!parsed.items.length) return back('No usable item rows were found.', 'Nothing to load');
      try {
        const parts: ItemImportIn['rows'][] = [];
        for (let i = 0; i < parsed.items.length; i += PART) parts.push(parsed.items.slice(i, i + PART));
        const plans: ItemImportPlan[] = [];
        for (const part of parts)
          plans.push(
            await api<ItemImportPlan>('POST', '/api/ingredients/import?mode=dry-run', {
              rows: part,
              brandId,
              grant,
              file: file.name,
            }),
          );
        review(file.name, parts, plans, parsed, brandId, grant);
      } catch (e) {
        back(errText(e));
      }
    }

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

    function review(
      file: string,
      parts: ItemImportIn['rows'][],
      plans: ItemImportPlan[],
      parsed: ReturnType<typeof parseItemRows>,
      brandId: string,
      grant: boolean,
    ) {
      const rows: ItemPlanRow[] = plans.flatMap((p) => p.rows);
      const sum = (k: keyof ItemImportPlan['counts']) => plans.reduce((a, p) => a + p.counts[k], 0);
      const nAdd = sum('add');
      const nUpd = sum('update');
      const nSame = sum('same');
      const nKeep = sum('keepPrice');
      const blocked = rows.filter((r) => r.action === 'blocked');
      const movers = rows
        .filter(
          (r) =>
            r.action === 'update' &&
            r.hasPrice &&
            (r.old == null || (r.price != null && Math.abs((r.old ?? 0) - r.price) > 1e-9)),
        )
        .sort((a, b) => Math.abs(b.pct ?? 9) - Math.abs(a.pct ?? 9));
      const nFileDupes = Object.keys(parsed.fileDupes).length;
      const bname = plans[0]?.brandName ?? 'Shared';
      const nCheck = rows.filter((r) => r.check).length;

      async function commit() {
        try {
          let added = 0;
          let updated = 0;
          for (let i = 0; i < parts.length; i++) {
            const r = await api<{ added: number; updated: number }>('POST', '/api/ingredients/import?mode=commit', {
              rows: parts[i],
              brandId,
              grant,
              file: file + (parts.length > 1 ? ` (part ${i + 1}/${parts.length})` : ''),
              hash: plans[i]!.hash,
            });
            added += r.added;
            updated += r.updated;
          }
          modal.close();
          toast(`${added} added · ${updated} repriced · every card re-costed`);
          router.refresh();
        } catch (e) {
          toast(errText(e));
        }
      }

      modal.open({
        title: 'Check the price list before loading',
        body: (
          <>
            <div className="row r3" style={s('margin-bottom:14px')}>
              <div className="kpi g" style={s('border-top-width:3px')}>
                <div className="k">New codes</div>
                <div className="v">{nAdd}</div>
              </div>
              <div className="kpi" style={s('border-top-width:3px')}>
                <div className="k">Changed</div>
                <div className="v">{nUpd}</div>
              </div>
              <div className="kpi" style={s('border-top-width:3px')}>
                <div className="k">No change</div>
                <div className="v">{nSame}</div>
              </div>
            </div>
            <p style={s('font-size:13px;margin-bottom:12px')}>
              <b>{file}</b> {'·'} {parsed.items.length} code{parsed.items.length === 1 ? '' : 's'} read {'·'} loading
              into <b>{bname}</b>.
            </p>
            {nFileDupes > 0 && (
              <div className="note" style={s('margin:0 0 10px')}>
                <b>
                  {nFileDupes} code{nFileDupes === 1 ? '' : 's'} appear more than once in this file.
                </b>{' '}
                The last row for each was used and the earlier ones ignored, so no code is duplicated in the library.
                Worth fixing at source.
                <div className="mono" style={s('margin-top:5px;font-size:11px;max-height:80px;overflow:auto')}>
                  {Object.keys(parsed.fileDupes)
                    .slice(0, 20)
                    .map((c) => `${c} ×${parsed.fileDupes[c]}`)
                    .join(' · ')}
                </div>
              </div>
            )}
            {nKeep > 0 && (
              <div className="note" style={s('margin:0 0 10px')}>
                {nKeep} row{nKeep === 1 ? ' has' : 's have'} an empty price cell. Those prices are left exactly as they
                are rather than being wiped.
              </div>
            )}
            {parsed.junk.length > 0 && (
              <div className="note" style={s('margin:0 0 10px')}>
                <b>
                  {parsed.junk.length} group label{parsed.junk.length === 1 ? '' : 's'} looked like spreadsheet wreckage
                </b>{' '}
                and were left unchanged:
                <div className="mono" style={s('margin-top:5px;font-size:11px;max-height:70px;overflow:auto')}>
                  {parsed.junk.slice(0, 10).join(' · ')}
                </div>
              </div>
            )}
            {(parsed.rejected.length > 0 || blocked.length > 0) && (
              <div className="note r" style={s('margin:0 0 10px')}>
                <b>
                  {parsed.rejected.length + blocked.length} row
                  {parsed.rejected.length + blocked.length === 1 ? '' : 's'} rejected
                </b>
                <div style={s('margin-top:5px;font-size:11.5px;max-height:110px;overflow:auto')}>
                  {[...parsed.rejected, ...blocked.map((b) => `${b.code}: ${b.reason}`)].slice(0, 15).map((x, i) => (
                    <div key={i}>{x}</div>
                  ))}
                </div>
                <div style={s('margin-top:6px;font-size:11.5px')}>
                  Unit must be Gram, Ml, Each or Slice. Price must be a number, or empty to leave it alone.
                </div>
              </div>
            )}
            {nCheck > 0 && (
              <div className="note" style={s('margin:0 0 10px')}>
                <b>
                  {nCheck} price{nCheck === 1 ? '' : 's'} move{nCheck === 1 ? 's' : ''} by more than{' '}
                  {Math.round(PRICE_VARIANCE_THRESHOLD * 100)}%.
                </b>{' '}
                Loading marks those ingredients <span className="pill p-warn">PRICE CHECK</span> so someone reviews
                them.
              </div>
            )}
            {movers.length > 0 ? (
              <>
                <h3
                  style={s(
                    'margin:14px 0 8px;font-size:12.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--org-dk)',
                  )}
                >
                  Biggest price moves
                </h3>
                <div className="tw" style={s('max-height:210px;overflow:auto')}>
                  <table>
                    <thead>
                      <tr>
                        <th style={s('width:110px')}>Code</th>
                        <th>Item</th>
                        <th className="n" style={s('width:96px')}>
                          Now
                        </th>
                        <th className="n" style={s('width:96px')}>
                          Becomes
                        </th>
                        <th className="c" style={s('width:120px')}>
                          Change
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {movers.slice(0, 40).map((p) => (
                        <tr key={p.code}>
                          <td className="mono" style={s('color:var(--org-dk);font-weight:700')}>
                            {p.code}
                          </td>
                          <td>{p.name}</td>
                          <td className="n">
                            {p.old == null ? <span style={s('color:var(--mute)')}>none</span> : cur(p.old, 6)}
                          </td>
                          <td className="n" style={s('font-weight:600')}>
                            {cur(p.price, 6)}
                          </td>
                          <td className="c">
                            {p.pct == null ? (
                              <span className="pill p-sub">new price</span>
                            ) : (
                              <>
                                <span
                                  className={`pill ${Math.abs(p.pct) <= 0.1 ? 'p-ok' : Math.abs(p.pct) <= 0.25 ? 'p-warn' : 'p-bad'}`}
                                >
                                  {(p.pct > 0 ? '+' : '') + (p.pct * 100).toFixed(0)}%
                                </span>
                                {p.check && (
                                  <>
                                    {' '}
                                    <span className="pill p-warn">PRICE CHECK</span>
                                  </>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {movers.length > 40 && (
                  <div style={s('font-size:11.5px;color:var(--mute);margin-top:6px')}>
                    Showing the 40 largest of {movers.length}.
                  </div>
                )}
                <div className="note" style={s('margin:10px 0 0')}>
                  Every recipe card using these items re-costs itself the moment this is loaded. Nothing needs
                  re-uploading.
                </div>
              </>
            ) : (
              <div className="note" style={s('margin:0')}>
                No price on any existing code changes.
              </div>
            )}
          </>
        ),
        foot: (
          <>
            <button className="btn o" onClick={upload}>
              Back
            </button>
            <button className="btn" disabled={!(nAdd + nUpd) || blocked.length > 0} onClick={commit}>
              Load {nAdd + nUpd} change{nAdd + nUpd === 1 ? '' : 's'}
            </button>
          </>
        ),
      });
    }

    modal.open({
      title: 'Upload a raw material price list',
      body: <UploadBody st={st} brands={brands} onFile={pickFile} />,
      foot: (
        <button className="btn o" onClick={modal.close}>
          Cancel
        </button>
      ),
    });
  }, [brands, modal, router, toast, workspace]);

  return { template, upload };
}

function UploadBody({
  st,
  brands,
  onFile,
}: {
  st: Store<{ brandId: string; grant: boolean }>;
  brands: Brand[];
  onFile: (f: File | undefined) => void;
}) {
  const f = useStore(st);
  return (
    <>
      <div className="field">
        <label className="fl">Load these items into</label>
        <select value={f.brandId} onChange={(e) => st.set({ brandId: e.target.value })}>
          <option value="">Shared {'–'} every brand can use them</option>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} only
            </option>
          ))}
        </select>
        <div style={s('font-size:11.5px;color:var(--mute);margin-top:6px')}>
          Pick a brand and these items appear only in that brand&apos;s recipe picker. Shared items stay available
          everywhere.
        </div>
      </div>
      <div className="field">
        <label className="fl">Existing codes</label>
        <label style={s('display:flex;gap:8px;align-items:flex-start;font-size:12.5px;cursor:pointer')}>
          <input
            type="checkbox"
            checked={f.grant}
            style={s('margin-top:2px')}
            onChange={(e) => st.set({ grant: e.target.checked })}
          />
          <span>
            Also grant this brand access to codes that already exist{' '}
            <span style={s('color:var(--mute)')}>(otherwise only their price and name are updated)</span>
          </span>
        </label>
      </div>
      <p style={s('font-size:13px;color:var(--mute);margin-bottom:6px')}>
        Excel or CSV. Columns are found by their heading, in any order {'–'} these names all work:
      </p>
      <p
        className="mono"
        style={s('background:var(--org-xl);padding:10px;border-radius:7px;margin:0 0 10px;font-size:11.5px')}
      >
        Item Code {'·'} Description or Item Name {'·'} Purchase UOM or UOM {'·'} Price per unit or Price {'·'} Group or
        Main Category {'·'} Sub group
      </p>
      <p style={s('font-size:12.5px;color:var(--mute)')}>
        Existing codes are repriced, new codes are added, and nothing is ever deleted. A code appearing twice is
        collapsed rather than duplicated. An empty price cell leaves that price alone. Unit must be Gram, Ml, Each or
        Slice. You see everything that will change before it is written.
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
              onFile(file);
            }}
          />
        </label>
      </div>
    </>
  );
}
