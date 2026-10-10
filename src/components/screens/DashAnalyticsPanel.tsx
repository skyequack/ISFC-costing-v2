'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from '@/components/shell/nav-progress';
import { Perm } from '@/components/shared/Perm';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import type { Quadrant } from '@/domain/dash-analytics';
import { cur, pct } from '@/lib/format';
import type { DashAnalytics } from '@/lib/services/dash';

const h3 = s('font-size:13px;letter-spacing:.05em;text-transform:uppercase;color:var(--org-dk)');

export function dashHref(f: DashAnalytics['filters']): string {
  const q = new URLSearchParams();
  if (f.brand !== '*') q.set('brand', f.brand);
  if (f.loc !== '*') q.set('loc', f.loc);
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  const t = q.toString();
  return t ? `/dash?${t}` : '/dash';
}

/** Wait this long after the last keystroke before a typed date is applied (a pick, Enter or leaving the field applies it at once). */
export const DATE_COMMIT_MS = 700;
/** A blank date (clears the filter) or a full date in a believable year: typing 2026 passes through 0002, 0020 and 0202. */
const committable = (v: string) =>
  v === '' || (/^\d{4}-\d{2}-\d{2}$/.test(v) && +v.slice(0, 4) >= 1900 && +v.slice(0, 4) <= 2200);

/** Date field that keeps what is typed and only changes the URL once the date is complete, so typing never fires a request per keystroke. */
function DateField({
  value,
  label,
  min,
  max,
  onCommit,
}: {
  value: string;
  label: string;
  min?: string;
  max?: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const commit = (v: string) => {
    clearTimeout(timer.current);
    if (v !== value && committable(v)) onCommit(v);
  };
  return (
    <input
      type="date"
      value={draft}
      min={min}
      max={max}
      aria-label={label}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => commit(v), DATE_COMMIT_MS);
      }}
      onBlur={() => commit(draft)}
      onKeyDown={(e) => e.key === 'Enter' && commit(draft)}
    />
  );
}

const active = (f: DashAnalytics['filters']) => f.brand !== '*' || f.loc !== '*' || !!f.from || !!f.to;

/** Filter bar (D-65): URL-driven like the Production screen; date and site only reach the production-driven sections. */
export function DashFilterBar({ a, error }: { a: DashAnalytics; error?: string }) {
  const router = useRouter();
  const f = a.filters;
  const go = (patch: Partial<DashAnalytics['filters']>) => {
    const n = { ...f, ...patch };
    if (patch.brand !== undefined) n.loc = '*'; // a site belongs to its brand(s)
    router.replace(dashHref(n));
  };
  const brandName = f.brand === '*' ? 'All brands' : (a.brandOptions.find((b) => b.id === f.brand)?.name ?? '');
  return (
    <>
      <div style={s('display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px')}>
        <label className="fl" style={s('margin:0')}>
          Brand
        </label>
        <select value={f.brand} onChange={(e) => go({ brand: e.target.value })} style={s('max-width:230px')}>
          <option value="*">All brands</option>
          {a.brandOptions.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        {a.sites.length > 0 && (
          <>
            <label className="fl" style={s('margin:0')}>
              Site
            </label>
            <select value={f.loc} onChange={(e) => go({ loc: e.target.value })} style={s('max-width:160px')}>
              <option value="*">All sites</option>
              {a.sites.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </>
        )}
        <label className="fl" style={s('margin:0')}>
          From
        </label>
        <DateField value={f.from} label="From date" max={f.to || undefined} onCommit={(v) => go({ from: v })} />
        <label className="fl" style={s('margin:0')}>
          To
        </label>
        <DateField value={f.to} label="To date" min={f.from || undefined} onCommit={(v) => go({ to: v })} />
        {active(f) && (
          <button className="btn sm o" onClick={() => router.replace('/dash')}>
            Reset
          </button>
        )}
      </div>
      {error && (
        <div className="note" style={s('margin-bottom:14px;color:var(--bad)')}>
          {error}
        </div>
      )}
      {active(f) && (
        <div className="note" style={s('margin-bottom:14px')}>
          Filtered: {brandName} {'·'} {f.loc === '*' ? 'All sites' : f.loc} {'·'} {f.from || 'start'} {'–'}{' '}
          {f.to || 'latest'}. Site and dates apply to the Menu Matrix, Margin at Risk, Cost Drivers and Unpriced
          Exposure. The KPIs, tables and Over Target respond to the brand only.
        </div>
      )}
    </>
  );
}

export function ExportAnalyticsButton({ filters }: { filters: DashAnalytics['filters'] }) {
  const toast = useToast();
  return (
    <Perm perm="export">
      <button
        className="btn o"
        onClick={() => {
          const q = new URLSearchParams({ brand: filters.brand, loc: filters.loc });
          if (filters.from) q.set('from', filters.from);
          if (filters.to) q.set('to', filters.to);
          window.location.href = `/api/export/dash?${q.toString()}`;
          toast('Analytics exported');
        }}
      >
        Export analytics
      </button>
    </Perm>
  );
}

const QUAD: Record<Quadrant, { title: string; sub: string; color: string }> = {
  puzzle: { title: 'Puzzles', sub: 'Unpopular, high margin', color: 'var(--org-dk)' },
  star: { title: 'Stars', sub: 'Popular, high margin', color: 'var(--grn-dk)' },
  dog: { title: 'Dogs', sub: 'Unpopular, low margin', color: 'var(--bad)' },
  plowhorse: { title: 'Plowhorses', sub: 'Popular, low margin', color: 'var(--mute)' },
};
const GRID: Quadrant[] = ['puzzle', 'star', 'dog', 'plowhorse'];

/** Menu Matrix (D-66): Kasavana-Smith popularity vs contribution, an HTML grid with clickable chips (prints, keyboard). */
function Matrix({ a }: { a: DashAnalytics }) {
  const router = useRouter();
  const m = a.matrix;
  const open = (code: string) => a.ids[code] && router.push(`/edit/${a.ids[code]}`);
  return (
    <>
      <h3 style={{ ...h3, margin: '26px 0 6px' }}>Menu Matrix</h3>
      <div style={s('font-size:12px;color:var(--mute);margin-bottom:10px')}>
        Popularity (portions produced) vs margin per portion; the dividing lines are the weighted averages.
      </div>
      {!m.points ? (
        <div className="card">
          <div className="empty">
            <p>Not enough data to classify yet</p>
            <p style={s('font-size:12px;color:var(--mute)')}>
              {m.classified} of 4 priced menu items with production in range.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div style={s('display:grid;grid-template-columns:1fr 1fr;gap:10px')}>
            {GRID.map((q) => {
              const pts = m.points!.filter((p) => p.quadrant === q);
              return (
                <div className="card" key={q} style={s('padding:12px;min-height:120px')}>
                  <div style={{ ...s('font-weight:700'), color: QUAD[q].color }}>
                    {QUAD[q].title} <span style={s('font-weight:400;color:var(--mute)')}>({pts.length})</span>
                  </div>
                  <div style={s('font-size:11px;color:var(--mute);margin-bottom:8px')}>{QUAD[q].sub}</div>
                  <div style={s('display:flex;flex-wrap:wrap;gap:6px;max-height:170px;overflow:auto')}>
                    {pts.map((p) => (
                      <button
                        key={p.code}
                        className="pill p-sub"
                        style={s('cursor:pointer;border:0')}
                        title={`${p.name}: ${p.portions} portions, ${cur(p.contribution)} per portion`}
                        onClick={() => open(p.code)}
                      >
                        {p.code}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={s('font-size:12px;color:var(--mute);margin:8px 0')}>
            Cut: {m.popularityCut!.toFixed(1)} portions {'·'} {cur(m.marginCut)} per portion
          </div>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Recipe</th>
                  <th className="n">Portions</th>
                  <th className="c">Share</th>
                  <th className="n">Margin / portion</th>
                  <th className="c">Class</th>
                </tr>
              </thead>
              <tbody>
                {m.points.map((p) => (
                  <tr key={p.code} onClick={() => open(p.code)} style={s('cursor:pointer')}>
                    <td className="mono">{p.code}</td>
                    <td>
                      <b>{p.name}</b>
                    </td>
                    <td className="n">{p.portions}</td>
                    <td className="c">{pct(p.share)}</td>
                    <td className="n">{cur(p.contribution)}</td>
                    <td className="c">{QUAD[p.quadrant].title.replace(/s$/, '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {(m.unpriced > 0 || m.noProduction > 0 || m.unvalued > 0) && (
        <div className="note" style={s('margin-top:8px')}>
          Not classified: {m.unpriced} with production but no selling price, {m.noProduction} priced with no production
          in this range{m.unvalued > 0 ? `, ${m.unvalued} whose cost could not be calculated` : ''}.
        </div>
      )}
    </>
  );
}

/** The new analytics sections, below the existing cards (D-66/D-67). */
export function DashAnalyticsSections({ a }: { a: DashAnalytics }) {
  const router = useRouter();
  const t = a.target;
  return (
    <>
      <Matrix a={a} />

      <h3 style={{ ...h3, margin: '26px 0 12px' }}>
        Margin at Risk{' '}
        {a.risk.total > 0 && (
          <>
            {'·'} {cur(a.risk.total)}
          </>
        )}
      </h3>
      {a.risk.rows.length === 0 ? (
        <div className="note">No priced card over the {pct(t)} target has production in this range.</div>
      ) : (
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Recipe</th>
                <th className="n">Portions</th>
                <th className="c">Food Cost %</th>
                <th className="n">Over target / portion</th>
                <th className="n">At risk</th>
              </tr>
            </thead>
            <tbody>
              {a.risk.rows.map((r) => (
                <tr
                  key={r.code}
                  onClick={() => a.ids[r.code] && router.push(`/edit/${a.ids[r.code]}`)}
                  style={s('cursor:pointer')}
                >
                  <td className="mono">{r.code}</td>
                  <td>
                    <b>{r.name}</b>
                  </td>
                  <td className="n">{r.portions}</td>
                  <td className="c">
                    <span className="pill p-warn">{pct(r.fcPct)}</span>
                  </td>
                  <td className="n">{cur(r.overPerPortion)}</td>
                  <td className="n">
                    <b>{cur(r.atRisk)}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 style={{ ...h3, margin: '26px 0 12px' }}>Cost Drivers</h3>
      {a.drivers.rows.length === 0 ? (
        <div className="note">No production in this range, so there is no ingredient spend to rank.</div>
      ) : (
        <>
          <div style={s('font-size:12px;color:var(--mute);margin-bottom:8px')}>
            Issue value of the produced portions, excluding the waste buffer. A = the first 80% of spend, B = to 95%.
            Top {a.drivers.rows.length} of {a.drivers.count}.
          </div>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Ingredient</th>
                  <th className="n">Quantity</th>
                  <th className="n">Cost</th>
                  <th className="c">Share</th>
                  <th className="c">Cumulative</th>
                  <th className="c">Class</th>
                </tr>
              </thead>
              <tbody>
                {a.drivers.rows.map((r) => (
                  <tr key={r.item.code}>
                    <td className="mono">{r.item.code}</td>
                    <td>
                      <b>{r.item.name}</b>
                    </td>
                    <td className="n">
                      {cur(r.item.purchaseQty, 2)} {r.item.uom}
                    </td>
                    <td className="n">{cur(r.cost)}</td>
                    <td className="c">{pct(r.share)}</td>
                    <td className="c">{pct(r.cumulative)}</td>
                    <td className="c">
                      <span className={`pill ${r.cls === 'A' ? 'p-bad' : r.cls === 'B' ? 'p-warn' : 'p-gr'}`}>
                        {r.cls}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {a.unpriced.count > 0 && (
        <>
          <h3 style={{ ...h3, margin: '26px 0 12px' }}>
            Unpriced Exposure {'·'} {a.unpriced.portions} portions
          </h3>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Recipe</th>
                  <th className="n">Portions</th>
                  <th className="c">Unpriced ingredients</th>
                </tr>
              </thead>
              <tbody>
                {a.unpriced.rows.map((r) => (
                  <tr
                    key={r.code}
                    onClick={() => a.ids[r.code] && router.push(`/edit/${a.ids[r.code]}`)}
                    style={s('cursor:pointer')}
                  >
                    <td className="mono">{r.code}</td>
                    <td>
                      <b>{r.name}</b>
                    </td>
                    <td className="n">{r.portions}</td>
                    <td className="c">
                      <span className="pill p-warn">{r.missing}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {a.overTarget.length > 0 && (
        <>
          <h3 style={{ ...h3, margin: '26px 0 12px' }}>Over Target</h3>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Recipe</th>
                  <th className="c">Food Cost %</th>
                  <th className="c">Points over {pct(t)}</th>
                </tr>
              </thead>
              <tbody>
                {a.overTarget.map((r) => (
                  <tr
                    key={r.code}
                    onClick={() => a.ids[r.code] && router.push(`/edit/${a.ids[r.code]}`)}
                    style={s('cursor:pointer')}
                  >
                    <td className="mono">{r.code}</td>
                    <td>
                      <b>{r.name}</b>
                    </td>
                    <td className="c">
                      <span className="pill p-warn">{pct(r.fcPct)}</span>
                    </td>
                    <td className="c">{pct(r.gap)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {(a.flags.unconvertible > 0 || a.flags.truncated > 0 || a.flags.unknown > 0) && (
        <div className="note" style={s('margin-top:14px')}>
          Some lines could not be valued ({a.flags.unconvertible} with no unit conversion, {a.flags.unknown} codes not
          in the library, {a.flags.truncated} too deep); the totals above leave them out.
        </div>
      )}
    </>
  );
}
