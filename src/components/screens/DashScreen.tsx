'use client';

import { useRouter } from '@/components/shell/nav-progress';
import { NewRecipeButton } from '@/components/recipes/NewRecipeButton';
import { Acts } from '@/components/shell/Shell';
import { s } from '@/components/ui';
import { cur, fcBar, fcClass, pct } from '@/lib/format';
import type { DashData } from '@/lib/screens/dash';
import type { DashAnalytics } from '@/lib/services/dash';
import { DashAnalyticsSections, DashFilterBar, ExportAnalyticsButton } from './DashAnalyticsPanel';

const TOP = 25;
const h3 = s('font-size:13px;letter-spacing:.05em;text-transform:uppercase;color:var(--org-dk)');

/** Legacy vDash (2614). Brand-scoped (D-07); the average notes how many cards it leaves out (D-30). */
export function DashScreen({
  d,
  a,
  filterError,
  brandNames,
}: {
  d: DashData;
  a: DashAnalytics;
  filterError?: string;
  brandNames: Record<string, string>;
}) {
  const router = useRouter();
  const t = d.target;
  const open = (id: string) => router.push(`/edit/${id}`);

  return (
    <>
      <Acts>
        <ExportAnalyticsButton filters={a.filters} />
        <NewRecipeButton />
      </Acts>
      <DashFilterBar a={a} error={filterError} />
      <div className="kpis">
        <div className="kpi">
          <div className="k">Menu Items</div>
          <div className="v">{d.menus}</div>
          <div className="n">
            {d.subs} sub-recipe{d.subs === 1 ? '' : 's'}
          </div>
        </div>
        <div className={`kpi ${d.avgFC == null ? '' : d.avgFC <= t ? 'g' : 'r'}`}>
          <div className="k">Average Food Cost</div>
          <div className="v">{pct(d.avgFC)}</div>
          <div className="n">
            target {pct(t)}
            {d.excluded ? ` · ${d.excluded} cards excluded (no selling price)` : ''}
          </div>
        </div>
        <div className={`kpi ${d.over ? 'w' : 'g'}`}>
          <div className="k">Over Target</div>
          <div className="v">{d.over}</div>
          <div className="n">of {d.priced} priced items</div>
        </div>
        <div className={`kpi ${d.loss ? 'r' : 'g'}`}>
          <div className="k">Selling At A Loss</div>
          <div className="v">{d.loss}</div>
          <div className="n">negative net profit</div>
        </div>
        <div className="kpi">
          <div className="k">Locked &amp; Approved</div>
          <div className="v">{d.locked}</div>
          <div className="n">of {d.total} cards</div>
        </div>
        <div className={`kpi ${d.flagged ? 'w' : ''}`}>
          <div className="k">Ingredients</div>
          <div className="v">{d.items}</div>
          <div className="n">
            {d.flagged} flagged, {d.noPrice} unpriced
          </div>
        </div>
      </div>

      {!d.totalMenus ? (
        <div className="card">
          <div className="empty">
            <div className="big">{'▤'}</div>
            <p>No recipe cards yet.</p>
            <p style={s('margin:14px 0')}>
              <NewRecipeButton label="Create your first card" />
            </p>
          </div>
        </div>
      ) : (
        <>
          <div style={s('display:flex;align-items:baseline;gap:10px;margin-bottom:10px')}>
            <h3 style={h3}>{d.totalMenus > TOP ? `Highest Food Cost · top ${TOP}` : 'All Menu Items'}</h3>
            {d.totalMenus > TOP && (
              <span style={s('font-size:12px;color:var(--mute)')}>
                of {d.totalMenus} {'·'}{' '}
                <a
                  href="/recipes"
                  onClick={(e) => {
                    e.preventDefault();
                    router.push('/recipes');
                  }}
                >
                  see all in Recipe Cards
                </a>
              </span>
            )}
          </div>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Recipe</th>
                  <th>Brand</th>
                  <th className="c">St</th>
                  <th className="n">Food Cost</th>
                  <th className="n">Total Cost</th>
                  <th className="n">Sales Price</th>
                  <th className="c">Food Cost %</th>
                  <th style={s('width:120px')}>vs Target</th>
                  <th className="n">Net Profit</th>
                  <th className="c">Net %</th>
                  <th className="c">Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {d.top.map((r) => {
                  const c = r.c;
                  const bar = fcBar(c.fcPct, t);
                  return (
                    <tr key={r.id} onClick={() => open(r.id)} style={s('cursor:pointer')}>
                      <td className="mono" style={s('color:var(--org-dk);font-weight:700')}>
                        {r.code}
                      </td>
                      <td>
                        <b>{r.name}</b>
                        <div style={s('font-size:11px;color:var(--mute)')}>{r.cat || ''}</div>
                      </td>
                      <td>
                        {r.brandId ? (
                          <span className="pill p-sub">{brandNames[r.brandId] ?? ''}</span>
                        ) : (
                          <span style={s('color:var(--mute)')}>{'—'}</span>
                        )}
                      </td>
                      <td className="c">
                        {r.status === 'LOCKED' ? (
                          <span className="pill p-lock">{'🔒'}</span>
                        ) : (
                          <span className="pill p-draft">D</span>
                        )}
                      </td>
                      <td className="n">{cur(c.food)}</td>
                      <td className="n">{cur(c.totalCost)}</td>
                      <td className="n">{c.sp ? cur(c.sp) : <span style={s('color:var(--mute)')}>not priced</span>}</td>
                      <td className="c">
                        <span className={`pill ${fcClass(c.fcPct, t)}`}>{pct(c.fcPct)}</span>
                      </td>
                      <td>
                        <div className="bar">
                          <i style={{ width: `${bar.w}%`, background: bar.col }}></i>
                        </div>
                      </td>
                      <td
                        className="n"
                        style={{ color: c.sp && c.net < 0 ? 'var(--bad)' : undefined, fontWeight: 600 }}
                      >
                        {c.sp ? cur(c.net) : '-'}
                      </td>
                      <td className="c">{pct(c.npPct)}</td>
                      <td className="c">
                        {c.err ? <span className="pill p-bad">{c.err}</span> : <span className="pill p-ok">OK</span>}
                      </td>
                      <td className="c">
                        <button
                          className="btn sm o"
                          onClick={(e) => {
                            e.stopPropagation();
                            open(r.id);
                          }}
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {(d.byBrand.length > 1 || d.byBrand[0]?.name !== '— no brand') && (
            <>
              <h3 style={{ ...h3, margin: '26px 0 12px' }}>Performance by Brand</h3>
              <div className="tw">
                <table>
                  <thead>
                    <tr>
                      <th>Brand</th>
                      <th className="c">Menu Items</th>
                      <th className="n">Avg Food Cost</th>
                      <th className="c">Avg FC %</th>
                      <th style={s('width:130px')}>vs Target</th>
                      <th className="c">Over Target</th>
                      <th className="n">Avg Net Profit</th>
                      <th className="c">Avg Net %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.byBrand.map((g) => {
                      const bar = fcBar(g.afc, t);
                      return (
                        <tr key={g.name}>
                          <td>
                            <b>{g.name}</b>
                          </td>
                          <td className="c">{g.n}</td>
                          <td className="n">{cur(g.afood)}</td>
                          <td className="c">
                            <span className={`pill ${fcClass(g.afc, t)}`}>{pct(g.afc)}</span>
                          </td>
                          <td>
                            <div className="bar">
                              <i style={{ width: `${bar.w}%`, background: bar.col }}></i>
                            </div>
                          </td>
                          <td className="c">
                            {g.over ? (
                              <span className="pill p-warn">{g.over}</span>
                            ) : (
                              <span className="pill p-ok">0</span>
                            )}
                          </td>
                          <td
                            className="n"
                            style={{ color: g.anet != null && g.anet < 0 ? 'var(--bad)' : undefined, fontWeight: 600 }}
                          >
                            {g.anet == null ? '-' : cur(g.anet)}
                          </td>
                          <td className="c">{pct(g.anp)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {d.subs > 0 && (
            <>
              <h3
                style={{
                  ...s('font-size:13px;letter-spacing:.05em;text-transform:uppercase;color:var(--grn-dk)'),
                  margin: '26px 0 12px',
                }}
              >
                Sub-Recipes{d.subs > 20 ? ` · first 20 of ${d.subs}` : ''}
              </h3>
              <div className="tw">
                <table>
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Name</th>
                      <th className="n">Batch Cost</th>
                      <th className="n">Batch Yield</th>
                      <th className="n">Cost per Unit</th>
                      <th className="c">Used In</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.subRows.map((r) => (
                      <tr key={r.id} onClick={() => open(r.id)} style={s('cursor:pointer')}>
                        <td className="mono" style={s('color:var(--grn-dk);font-weight:700')}>
                          {r.code}
                        </td>
                        <td>
                          <b>{r.name}</b>
                        </td>
                        <td className="n">{cur(r.c.batch)}</td>
                        <td className="n">
                          {cur(r.c.bOut, 0)} {r.c.bUom}
                        </td>
                        <td className="n">
                          <b>{cur(r.c.unitCost, 6)}</b>
                        </td>
                        <td className="c">
                          {r.used ? (
                            <span className="pill p-sub">
                              {r.used} card{r.used === 1 ? '' : 's'}
                            </span>
                          ) : (
                            <span className="pill p-gr">unused</span>
                          )}
                        </td>
                        <td className="c">
                          <button
                            className="btn sm o"
                            onClick={(e) => {
                              e.stopPropagation();
                              open(r.id);
                            }}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
      <DashAnalyticsSections a={a} />
    </>
  );
}
