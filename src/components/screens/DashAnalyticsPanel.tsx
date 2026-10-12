'use client';

import { useRouter } from '@/components/shell/nav-progress';
import { DateField } from '@/components/shared/DateField';
import { Perm } from '@/components/shared/Perm';
import { downloadFile } from '@/components/io/download';
import { errText } from '@/components/shared/api-client';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { MATRIX_MIN_ITEMS } from '@/domain/dash-analytics';
import { cur, pct } from '@/lib/format';
import type { DashAnalytics } from '@/lib/services/dash';
import { QUAD, QUAD_ORDER, TVA_REASON } from './DashCharts';

/** The dashboard tabs (D-82). The overview is the default and is left out of the URL. */
export const DASH_TABS = ['overview', 'menu', 'margin', 'ingredients', 'brands'] as const;
export type DashTab = (typeof DASH_TABS)[number];

/** Reads the URL hash (without the #); anything unknown or missing is the overview. */
export function dashTab(v: string | null | undefined): DashTab {
  return DASH_TABS.find((t) => t === v) ?? 'overview';
}

const h3 = s('font-size:13px;letter-spacing:.05em;text-transform:uppercase;color:var(--org-dk)');
/** Section heading inside a tab panel (the panel itself already gives the top spacing). */
const sectionH3 = { ...h3, margin: '0 0 10px' };
const sub = s('font-size:12px;color:var(--mute);margin-bottom:10px');

/**
 * Filters in the query string, the tab in the hash (#menu etc.). The overview has no hash, so the old links still work.
 * The tab is not a query parameter: a query change re-runs the server page, a hash change does not (D-84).
 */
export function dashHref(f: DashAnalytics['filters'], tab: DashTab = 'overview'): string {
  const q = new URLSearchParams();
  if (f.brand !== '*') q.set('brand', f.brand);
  if (f.loc !== '*') q.set('loc', f.loc);
  if (f.client !== '*') q.set('client', f.client);
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  const t = q.toString();
  const base = t ? `/dash?${t}` : '/dash';
  return tab === 'overview' ? base : `${base}#${tab}`;
}

const active = (f: DashAnalytics['filters']) =>
  f.brand !== '*' || f.loc !== '*' || f.client !== '*' || !!f.from || !!f.to;

const CLEAR: DashAnalytics['filters'] = { brand: '*', loc: '*', client: '*', from: '', to: '' };

/** Filter bar (D-65): URL-driven like the Production screen; date and site only reach the production-driven sections. */
export function DashFilterBar({ a, error, tab = 'overview' }: { a: DashAnalytics; error?: string; tab?: DashTab }) {
  const router = useRouter();
  const f = a.filters;
  const go = (patch: Partial<DashAnalytics['filters']>) => {
    const n = { ...f, ...patch };
    if (patch.brand !== undefined) {
      n.loc = '*'; // a site belongs to its brand(s)
      n.client = '*'; // and so does a client
    }
    router.replace(dashHref(n, tab));
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
        {a.clientOptions.length > 0 && (
          <>
            <label className="fl" style={s('margin:0')}>
              Client
            </label>
            <select value={f.client} onChange={(e) => go({ client: e.target.value })} style={s('max-width:200px')}>
              <option value="*">All clients</option>
              <option value="none">Unassigned</option>
              {a.clientOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
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
          <button className="btn sm o" onClick={() => router.replace(dashHref(CLEAR, tab))}>
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
          Filtered: {brandName} {'·'} {f.loc === '*' ? 'All sites' : f.loc} {'·'}{' '}
          {f.client === '*'
            ? 'All clients'
            : f.client === 'none'
              ? 'Unassigned'
              : (a.clientOptions.find((c) => c.id === f.client)?.name ?? '')}{' '}
          {'·'} {f.from || 'start'} {'–'} {f.to || 'latest'}. Site and dates apply to the Food-cost spread, Menu Matrix,
          Margin at Risk, Cost Drivers and Unpriced Exposure. The KPIs, tables and Over Target respond to the brand
          only. The client choice applies to the same sections, and Theoretical vs Actual follows all of the filters.
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
        onClick={async () => {
          const q = new URLSearchParams({ brand: filters.brand, loc: filters.loc, client: filters.client });
          if (filters.from) q.set('from', filters.from);
          if (filters.to) q.set('to', filters.to);
          try {
            await downloadFile(`/api/export/dash?${q.toString()}`);
            toast('Analytics exported');
          } catch (e) {
            toast(errText(e));
          }
        }}
      >
        Export analytics
      </button>
    </Perm>
  );
}

/** Menu tab, lower part: the Menu Matrix (D-66), an HTML grid with clickable chips (prints, keyboard). */
export function MatrixSection({ a }: { a: DashAnalytics }) {
  const router = useRouter();
  const m = a.matrix;
  const open = (code: string) => {
    const id = a.ids[code];
    if (id) router.push(`/edit/${id}`);
  };
  return (
    <>
      <h3 style={sectionH3}>Menu Matrix</h3>
      <div style={sub}>
        Popularity (portions produced) vs margin per portion; the dividing lines are the weighted averages.
      </div>
      {!m.points ? (
        <div className="card">
          <div className="empty">
            <p>Not enough data to classify yet</p>
            <p style={s('font-size:12px;color:var(--mute)')}>
              {m.classified} of {MATRIX_MIN_ITEMS} priced menu items with production in range.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div style={s('display:grid;grid-template-columns:1fr 1fr;gap:10px')}>
            {QUAD_ORDER.map((q) => {
              const pts = m.points!.filter((p) => p.quadrant === q);
              return (
                <div className="card" key={q} style={s('padding:12px;min-height:110px')}>
                  <div style={{ ...s('font-weight:700'), color: QUAD[q].color }}>
                    {QUAD[q].title} <span style={s('font-weight:400;color:var(--mute)')}>({pts.length})</span>
                  </div>
                  <div style={s('font-size:11px;color:var(--mute);margin-bottom:8px')}>{QUAD[q].sub}</div>
                  <div style={s('display:flex;flex-wrap:wrap;gap:6px;max-height:150px;overflow:auto')}>
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

/** Margin & Costs tab: what it costs now (Margin at Risk), which cards are over target, and what is unpriced. */
export function MarginSection({ a }: { a: DashAnalytics }) {
  const router = useRouter();
  const t = a.target;
  const openCode = (code: string) => {
    const id = a.ids[code];
    if (id) router.push(`/edit/${id}`);
  };
  return (
    <>
      <h3 style={sectionH3}>
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
                <tr key={r.code} onClick={() => openCode(r.code)} style={s('cursor:pointer')}>
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

      <h3 style={{ ...sectionH3, marginTop: 22 }}>Over Target</h3>
      {a.overTarget.length === 0 ? (
        <div className="note">No card is over the target.</div>
      ) : (
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
                <tr key={r.code} onClick={() => openCode(r.code)} style={s('cursor:pointer')}>
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
      )}

      {a.unpriced.count > 0 && (
        <>
          <h3 style={{ ...sectionH3, marginTop: 22 }}>
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
                  <tr key={r.code} onClick={() => openCode(r.code)} style={s('cursor:pointer')}>
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
    </>
  );
}

/** Ingredients tab: Cost Drivers (Pareto), Theoretical vs Actual (D-74) and the note about lines that could not be valued. */
export function IngredientsSection({ a }: { a: DashAnalytics }) {
  return (
    <>
      <h3 style={sectionH3}>Cost Drivers</h3>
      {a.drivers.rows.length === 0 ? (
        <div className="note">No production in this range, so there is no ingredient spend to rank.</div>
      ) : (
        <>
          <div style={sub}>
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

      <div style={{ marginTop: 22 }}>
        <TvaSection a={a} />
      </div>

      {(a.flags.unconvertible > 0 || a.flags.truncated > 0 || a.flags.unknown > 0) && (
        <div className="note" style={s('margin-top:14px')}>
          Some lines could not be valued ({a.flags.unconvertible} with no unit conversion, {a.flags.unknown} codes not
          in the library, {a.flags.truncated} too deep); the totals above leave them out.
        </div>
      )}
    </>
  );
}

const VERDICT: Record<'within' | 'over' | 'under', { label: string; cls: string }> = {
  within: { label: 'within allowance', cls: 'p-ok' },
  over: { label: 'over', cls: 'p-bad' },
  under: { label: 'under', cls: 'p-warn' },
};

/** Theoretical vs Actual (D-74): requisition usage against opening + receipts - closing, per ingredient. */
export function TvaSection({ a }: { a: DashAnalytics }) {
  const t = a.tva;
  const counted = t.sites.filter((x) => x.state === 'counted');
  return (
    <>
      <h3 style={sectionH3}>Theoretical vs Actual</h3>
      <div style={sub}>
        Theoretical is what the produced portions should have used, without the waste buffer. Actual is the opening
        count plus receipts minus the closing count, over the days between each site&apos;s counts.
      </div>
      {t.mode === 'actual' ? (
        <div className="note" style={s('margin-bottom:10px')}>
          Compared at {t.counted} of {t.total} site{t.total === 1 ? '' : 's'}:{' '}
          {counted.map((x, k) => (
            <span key={x.site}>
              {k > 0 && '; '}
              <b>{x.site}</b> {x.from} {'→'} {x.to}
            </span>
          ))}
          . Days after the first count up to the second are included.
        </div>
      ) : (
        <div className="note" style={s('margin-bottom:10px')}>
          {TVA_REASON[t.reason ?? 'no-count']}
        </div>
      )}
      {t.unallocated && (
        <div className="note" style={s('margin-bottom:10px')}>
          {cur(t.unallocated.portions, 0)} portions were produced with no site; they are not compared (theoretical value{' '}
          {cur(t.unallocated.value)}
          {t.unallocated.unpriced > 0 ? `, ${t.unallocated.unpriced} ingredient(s) without a price` : ''}).
        </div>
      )}
      {t.rows.length === 0 ? (
        <div className="note">No production in this range.</div>
      ) : (
        <>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Ingredient</th>
                  <th className="n">Theoretical</th>
                  <th className="n">Allowed up to</th>
                  <th className="n">Actual</th>
                  <th className="n">Deviation</th>
                  <th className="n">Value</th>
                  <th className="c">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {t.rows.map((r) => (
                  <tr key={r.code}>
                    <td>
                      <b>{r.name}</b>
                      <div className="mono" style={s('font-size:11px;color:var(--mute)')}>
                        {r.code}
                      </div>
                    </td>
                    <td className="n">
                      {cur(r.theoretical, 2)} {r.uom}
                    </td>
                    <td className="n">{cur(r.ceiling, 2)}</td>
                    <td className="n">{r.actual === null ? 'n/a' : cur(r.actual, 2)}</td>
                    <td className="n">{r.deviation === null ? 'n/a' : cur(r.deviation, 2)}</td>
                    <td className="n">{r.value === null ? 'n/a' : cur(r.value)}</td>
                    <td className="c">
                      {r.verdict ? (
                        <span className={`pill ${VERDICT[r.verdict].cls}`}>{VERDICT[r.verdict].label}</span>
                      ) : (
                        <span className="pill p-gr">n/a</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {t.count > t.rows.length && (
            <div style={s('font-size:12px;color:var(--mute);margin-top:6px')}>
              Top {t.rows.length} of {t.count}; the export has them all.
            </div>
          )}
        </>
      )}
      {t.flagged > 0 && (
        <div className="note" style={s('margin-top:10px')}>
          {t.flagged} ingredient{t.flagged === 1 ? ' has' : 's have'} a recipe line with no unit conversion, so the
          usage is understated and there is no verdict.
        </div>
      )}
    </>
  );
}
