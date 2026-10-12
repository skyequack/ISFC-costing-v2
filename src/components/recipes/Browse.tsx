'use client';

import { useEffect, useRef } from 'react';
import { api } from '@/components/shared/api-client';
import { createStore, useStore, type Store } from '@/components/shared/form-store';
import type { useModal } from '@/components/shared/Modal';
import { s } from '@/components/ui';
import { cur } from '@/lib/format';
import type { PickOption } from '@/lib/services/catalog-search';
import { UNITS } from '@/lib/units';
import type { EditLine } from './LineRow';

interface BrowseState {
  q: string;
  res: { all: PickOption[]; total: number } | null;
}

/** Legacy browseAdd (3608): "Search raw materials" modal. Adding keeps the dialog open so several items can go in. */
export function openBrowse(
  modal: ReturnType<typeof useModal>,
  brandId: string,
  onAdd: (code: string, unit: EditLine['unit']) => void,
  toast: (m: string) => void,
) {
  const st = createStore<BrowseState>({ q: '', res: null });
  modal.open({
    title: 'Search raw materials',
    body: <BrowseBody st={st} brandId={brandId} onAdd={onAdd} toast={toast} />,
    foot: (
      <button className="btn o" onClick={modal.close}>
        Done
      </button>
    ),
  });
}

function BrowseBody({
  st,
  brandId,
  onAdd,
  toast,
}: {
  st: Store<BrowseState>;
  brandId: string;
  onAdd: (code: string, unit: EditLine['unit']) => void;
  toast: (m: string) => void;
}) {
  const f = useStore(st);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        st.set({
          res: await api(
            'GET',
            `/api/catalog/search?brandId=${encodeURIComponent(brandId)}&q=${encodeURIComponent(f.q.trim())}&limit=60`,
          ),
        });
      } catch {
        st.set({ res: { all: [], total: 0 } });
      }
    }, 120);
    return () => clearTimeout(timer.current);
  }, [f.q, brandId, st]);

  const res = f.res;
  return (
    <>
      <input
        id="b_q"
        type="text"
        placeholder="Type an item name or code, e.g. tomato, chicken, PRD1..."
        value={f.q}
        autoFocus
        onChange={(e) => st.set({ q: e.target.value })}
        style={s('margin-bottom:14px')}
      />
      <div id="b_res">
        {!res ? null : !res.all.length ? (
          <div className="empty" style={s('padding:30px')}>
            No ingredient matches that
          </div>
        ) : (
          <>
            <div style={s('font-size:11.5px;color:var(--mute);margin-bottom:8px')}>
              {f.q ? `${res.total} match${res.total === 1 ? '' : 'es'}` : `${res.total} ingredients`}
              {res.total > res.all.length ? ` · showing first ${res.all.length}` : ''}
            </div>
            <div className="tw h" style={s('box-shadow:none')}>
              <table>
                <thead>
                  <tr>
                    <th style={s('width:118px')}>Code</th>
                    <th>Item</th>
                    <th className="c" style={s('width:56px')}>
                      UOM
                    </th>
                    <th className="n" style={s('width:92px')}>
                      Price
                    </th>
                    <th style={s('width:62px')}></th>
                  </tr>
                </thead>
                <tbody>
                  {res.all.map((o) => (
                    <tr key={o.code}>
                      <td
                        className="mono"
                        style={s(`color:${o.sub ? 'var(--grn-dk)' : 'var(--org-dk)'};font-weight:700`)}
                      >
                        {o.code}
                      </td>
                      <td style={s('font-size:12.5px')}>
                        {o.name}
                        {o.sub && (
                          <>
                            {' '}
                            <span className="pill p-sub">sub</span>
                          </>
                        )}
                      </td>
                      <td className="c" style={s('font-size:11px;color:var(--mute)')}>
                        {o.uom}
                      </td>
                      <td className="n mono" style={s('font-size:11.5px')}>
                        {o.price == null ? <span className="pill p-bad">none</span> : cur(o.price, 6)}
                      </td>
                      <td className="c">
                        <button
                          className="btn sm"
                          onClick={() => {
                            onAdd(
                              o.code,
                              ((UNITS as readonly string[]).includes(o.uom) ? o.uom : 'Gram') as EditLine['unit'],
                            );
                            toast(`Added ${o.name}  ·  ${cur(o.price ?? 0, 6)} per ${o.uom}`);
                          }}
                        >
                          Add
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
