'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from '@/components/shell/nav-progress';
import { api, errText } from '@/components/shared/api-client';
import { DateField } from '@/components/shared/DateField';
import { usePerm } from '@/components/shared/session-context';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { MAX_STOCK_QTY } from '@/lib/stock-limits';
import type { StockGrid } from '@/lib/services/stock';

export const STOCK_PAGE = 100;

const href = (site: string, date: string, kind: string) =>
  `/stock?${new URLSearchParams({ site, date, kind }).toString()}`;

/** Parse a typed quantity: '' = nothing, otherwise a number >= 0. Returns undefined when it is not one. */
function parseQty(text: string): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= MAX_STOCK_QTY ? n : undefined;
}

/** Stock counts and receipts per site and day (D-73): a grid of the ingredients in scope, saved all at once. */
export function StockScreen({ grid }: { grid: StockGrid }) {
  const router = useRouter();
  const toast = useToast();
  const canEdit = usePerm()('stock.edit');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [entered, setEntered] = useState(false);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dateReset, setDateReset] = useState(0);
  const isCount = grid.kind === 'count';
  const dirty = Object.keys(edits).length;

  // another site, day or kind starts clean (a refresh of the same one keeps what is being typed)
  const view = `${grid.site}|${grid.date}|${grid.kind}`;
  useEffect(() => setEdits({}), [view]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  /** Go to another site, day or kind; with unsaved changes it asks first. Returns false when the user stayed. */
  const go = (patch: Partial<{ site: string; date: string; kind: string }>): boolean => {
    if (dirty && !window.confirm(`${dirty} unsaved change${dirty === 1 ? '' : 's'} will be lost. Continue?`))
      return false;
    router.replace(href(patch.site ?? grid.site, patch.date ?? grid.date, patch.kind ?? grid.kind));
    return true;
  };

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return grid.rows.filter((r) => {
      if (needle && !r.code.toLowerCase().includes(needle) && !r.name.toLowerCase().includes(needle)) return false;
      if (!entered) return true;
      const text = edits[r.code];
      return text !== undefined ? text.trim() !== '' : r.qty !== null;
    });
  }, [grid.rows, q, entered, edits]);
  const pages = Math.max(1, Math.ceil(shown.length / STOCK_PAGE));
  const at = Math.min(page, pages - 1);
  const slice = shown.slice(at * STOCK_PAGE, (at + 1) * STOCK_PAGE);

  const set = (code: string, stored: number | null, text: string) =>
    setEdits((m) => {
      const { [code]: _drop, ...rest } = m;
      void _drop;
      // a blank equals "nothing stored", and on the receipt view 0 means the same (it clears)
      const norm = (v: number | null | undefined) => (!isCount && v === 0 ? null : v);
      const typed = norm(parseQty(text));
      const same = typed === norm(stored);
      return same ? rest : { ...rest, [code]: text };
    });

  async function save() {
    const cells: { code: string; qty: number | null }[] = [];
    for (const [code, text] of Object.entries(edits)) {
      const qty = parseQty(text);
      if (qty === undefined) return toast(`${code}: enter a number from 0 to 1,000,000,000`);
      cells.push({ code, qty });
    }
    cells.sort((x, y) => x.code.localeCompare(y.code)); // a stable request
    setBusy(true);
    try {
      const r = await api<{ saved: number; cleared: number }>('PUT', '/api/stock', {
        site: grid.site,
        date: grid.date,
        kind: grid.kind,
        cells,
      });
      toast(`${r.saved} ${isCount ? 'counts' : 'receipts'} saved${r.cleared ? `, ${r.cleared} cleared` : ''}`);
      setEdits({});
      router.refresh();
    } catch (e) {
      toast(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const head = (
    <div style={s('display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px')}>
      <label className="fl" style={s('margin:0')}>
        Site
      </label>
      <select value={grid.site} onChange={(e) => go({ site: e.target.value })} style={s('max-width:200px')}>
        {grid.sites.map((x) => (
          <option key={x} value={x}>
            {x}
          </option>
        ))}
      </select>
      <label className="fl" style={s('margin:0')}>
        Date
      </label>
      <DateField
        key={`${grid.date}:${dateReset}`}
        value={grid.date}
        label="Date"
        allowBlank={false}
        onCommit={(v) => {
          if (!go({ date: v })) setDateReset((n) => n + 1); // stayed: put the field back on the day the grid shows
        }}
      />
      <button className={`btn ${isCount ? '' : 'o'}`} onClick={() => go({ kind: 'count' })}>
        Count
      </button>
      <button className={`btn ${isCount ? 'o' : ''}`} onClick={() => go({ kind: 'receipt' })}>
        Receipt
      </button>
      <input
        type="text"
        value={q}
        placeholder="Search ingredient or code"
        onChange={(e) => (setQ(e.target.value), setPage(0))}
        style={s('width:230px')}
      />
      <label style={s('display:flex;gap:6px;align-items:center;font-size:13px')}>
        <input type="checkbox" checked={entered} onChange={(e) => (setEntered(e.target.checked), setPage(0))} />
        Entered only
      </label>
    </div>
  );

  if (!grid.sites.length)
    return (
      <div className="card">
        <div className="empty">
          <div className="big">{'▦'}</div>
          <p>No sites yet.</p>
          <p style={s('font-size:12px;color:var(--mute)')}>A brand&apos;s sites are added in Cost Settings.</p>
        </div>
      </div>
    );

  return (
    <>
      {head}
      {!canEdit && <div className="rolebar">View only</div>}
      <div className="note">
        {isCount
          ? 'The quantity on the shelf for each ingredient on this date, in its purchase unit. Leave a row blank if it was not counted; type 0 if it was counted and nothing was left.'
          : 'What was delivered on this date, in the ingredient’s purchase unit. Deliveries from an uploaded file show in their own column and are not changed here.'}
      </div>
      <div className="tw" style={s('margin-top:12px')}>
        <table>
          <thead>
            <tr>
              <th style={s('width:150px')}>Code</th>
              <th>Item</th>
              <th style={s('width:90px')}>Unit</th>
              {!isCount && (
                <th className="n" style={s('width:130px')}>
                  Other deliveries
                </th>
              )}
              <th className="c" style={s('width:140px')}>
                {isCount ? 'Counted' : 'Delivered'}
              </th>
            </tr>
          </thead>
          <tbody>
            {slice.map((r) => {
              const text = edits[r.code] ?? (r.qty === null ? '' : String(r.qty));
              return (
                <tr key={r.code}>
                  <td className="mono">{r.code}</td>
                  <td>
                    <b>{r.name}</b>
                  </td>
                  <td>{r.uom}</td>
                  {!isCount && (
                    <td className="n">{r.other ? r.other : <span style={s('color:var(--mute)')}>-</span>}</td>
                  )}
                  <td className="c">
                    {canEdit ? (
                      <input
                        className="cell"
                        type="number"
                        min="0"
                        step="any"
                        aria-label={`${r.code} quantity`}
                        value={text}
                        placeholder=""
                        style={{
                          ...s('width:110px;text-align:right'),
                          background: r.code in edits ? 'var(--org-lt, #fff3e6)' : undefined,
                        }}
                        onChange={(e) => set(r.code, r.qty, e.target.value)}
                      />
                    ) : (
                      <span>{r.qty === null ? <span style={s('color:var(--mute)')}>-</span> : r.qty}</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!slice.length && (
              <tr>
                <td colSpan={isCount ? 4 : 5} style={s('text-align:center;color:var(--mute);padding:18px')}>
                  {entered ? 'Nothing entered for this site and date yet.' : 'No ingredients match.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={s('display:flex;gap:10px;align-items:center;margin:12px 0;flex-wrap:wrap')}>
        <button className="btn sm o" disabled={at === 0} onClick={() => setPage(at - 1)}>
          Previous
        </button>
        <span style={s('font-size:12px;color:var(--mute)')}>
          {shown.length
            ? `${at * STOCK_PAGE + 1}–${Math.min(shown.length, (at + 1) * STOCK_PAGE)} of ${shown.length}`
            : '0'}
        </span>
        <button className="btn sm o" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>
          Next
        </button>
        {canEdit && (
          <>
            <span style={{ flex: 1 }} />
            <span style={s('font-size:12px;color:var(--mute)')}>{dirty ? `${dirty} unsaved` : ''}</span>
            <button className="btn" disabled={!dirty || busy} onClick={save}>
              Save all
            </button>
          </>
        )}
      </div>
    </>
  );
}
