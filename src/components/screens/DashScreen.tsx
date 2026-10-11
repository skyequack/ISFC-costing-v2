'use client';

import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useRouter } from '@/components/shell/nav-progress';
import { NewRecipeButton } from '@/components/recipes/NewRecipeButton';
import { Acts } from '@/components/shell/Shell';
import { s } from '@/components/ui';
import { MATRIX_MIN_ITEMS } from '@/domain/dash-analytics';
import { cur, fcBar, fcClass, pct } from '@/lib/format';
import type { DashData } from '@/lib/screens/dash';
import type { DashAnalytics } from '@/lib/services/dash';
import {
  DashFilterBar,
  ExportAnalyticsButton,
  IngredientsSection,
  MarginSection,
  MatrixSection,
  dashTab,
  type DashTab,
} from './DashAnalyticsPanel';
import {
  BrandBars,
  DriverBars,
  FoodCostGauge,
  FoodCostSpread,
  MatrixScatter,
  OverviewCard,
  RiskBars,
  TvaHeadline,
} from './DashCharts';

const TOP = 25;
const TOP_SUB = 20;
const h3 = s('font-size:13px;letter-spacing:.05em;text-transform:uppercase;color:var(--org-dk)');
const sectionH3 = { ...h3, margin: '0 0 10px' };

const TABS: { id: DashTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'menu', label: 'Menu' },
  { id: 'margin', label: 'Margin & Costs' },
  { id: 'ingredients', label: 'Ingredients' },
  { id: 'brands', label: 'Brands & Sub-recipes' },
];

/**
 * Dashboard (legacy vDash, 2614), now tabbed (D-84). The active tab lives in React state and mirrors the URL hash, so
 * links and Back/Forward work, and a tab click costs no server request. Every panel stays in the DOM and the inactive
 * ones are `hidden`, so switching is instant. Brand scoping (D-07) and the excluded-card note (D-30) are unchanged.
 */
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
  const [tab, setTab] = useState<DashTab>('overview');
  // The hash is read after mount (the server has no hash), and again on Back/Forward.
  useEffect(() => {
    const sync = () => setTab(dashTab(window.location.hash.slice(1)));
    sync();
    // popstate: Back/Forward; hashchange: a link to /dash#tab from elsewhere on the same page (D-84)
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);
  const open = (id: string) => router.push(`/edit/${id}`);
  const goTab = (next: DashTab) => {
    if (next === tab) return;
    // Through the router, like the filters, so Back and Forward keep the URL and the data in step (D-84).
    const { pathname, search } = window.location;
    router.push(next === 'overview' ? `${pathname}${search}` : `${pathname}${search}#${next}`);
    setTab(next);
    window.scrollTo({ top: 0 });
  };
  /** ArrowLeft / ArrowRight move between tabs, as the ARIA tab pattern expects. */
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = TABS.findIndex((x) => x.id === tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!.id;
    goTab(next);
    document.getElementById(`dash-tab-${next}`)?.focus();
  };

  return (
    <>
      <Acts>
        <ExportAnalyticsButton filters={a.filters} />
        <NewRecipeButton />
      </Acts>
      <DashFilterBar a={a} error={filterError} tab={tab} />
      <div
        role="tablist"
        aria-label="Dashboard sections"
        className="tabs"
        onKeyDown={onTabKey}
        style={s('overflow-x:auto;white-space:nowrap;margin-bottom:12px')}
      >
        {TABS.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            id={`dash-tab-${x.id}`}
            aria-selected={tab === x.id}
            aria-controls={`dash-panel-${x.id}`}
            tabIndex={tab === x.id ? 0 : -1}
            className={tab === x.id ? 'on' : undefined}
            onClick={() => goTab(x.id)}
          >
            {x.label}
          </button>
        ))}
      </div>

      <Panel id="overview" tab={tab}>
        <OverviewPanel d={d} a={a} onGo={goTab} />
      </Panel>

      <Panel id="menu" tab={tab}>
        {!d.totalMenus ? <EmptyCards /> : <TopCardsTable d={d} brandNames={brandNames} open={open} />}
        <div style={{ marginTop: 22 }}>
          <MatrixSection a={a} />
        </div>
      </Panel>

      <Panel id="margin" tab={tab}>
        <MarginSection a={a} />
      </Panel>

      <Panel id="ingredients" tab={tab}>
        <IngredientsSection a={a} />
      </Panel>

      <Panel id="brands" tab={tab}>
        {d.totalMenus > 0 && (
          <>
            {(d.byBrand.length > 1 || d.byBrand[0]?.name !== '— no brand') && <BrandsTable d={d} />}
            {d.subs > 0 && <SubRecipesTable d={d} open={open} />}
          </>
        )}
      </Panel>
    </>
  );
}

/** One tab's panel. Hidden when it is not the active tab; the id pairs it with its tab button for screen readers. */
function Panel({ id, tab, children }: { id: DashTab; tab: DashTab; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`dash-panel-${id}`} aria-labelledby={`dash-tab-${id}`} hidden={tab !== id}>
      {children}
    </div>
  );
}

function EmptyCards() {
  return (
    <div className="card">
      <div className="empty">
        <div className="big">{'▤'}</div>
        <p>No recipe cards yet.</p>
        <p style={s('margin:14px 0')}>
          <NewRecipeButton label="Create your first card" />
        </p>
      </div>
    </div>
  );
}

/** A KPI tile that is a button: it opens the detail tab that holds the full data behind the number. */
function KpiTile({
  to,
  cls,
  k,
  v,
  n,
  onGo,
}: {
  to: DashTab;
  cls?: string;
  k: string;
  v: ReactNode;
  n: ReactNode;
  onGo: (t: DashTab) => void;
}) {
  return (
    <button type="button" className={`kpi kpi-link ${cls ?? ''}`} onClick={() => onGo(to)}>
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      <span className="n">{n}</span>
    </button>
  );
}

/**
 * Overview: six KPI tiles and six graphics on one desktop screen. Every tile and every card opens the tab with the
 * table behind it. Only data already in DashData / DashAnalytics is read; nothing is recalculated here.
 */
function OverviewPanel({ d, a, onGo }: { d: DashData; a: DashAnalytics; onGo: (t: DashTab) => void }) {
  const t = d.target;
  return (
    <>
      {!d.totalMenus && <EmptyCards />}
      <div className="kpis" style={s('margin-bottom:12px')}>
        <KpiTile
          to="menu"
          k="Menu Items"
          v={d.menus}
          n={`${d.subs} sub-recipe${d.subs === 1 ? '' : 's'}`}
          onGo={onGo}
        />
        <KpiTile
          to="brands"
          cls={d.avgFC == null ? '' : d.avgFC <= t ? 'g' : 'r'}
          k="Average Food Cost"
          v={pct(d.avgFC)}
          n={`target ${pct(t)}${d.excluded ? ` · ${d.excluded} cards excluded (no selling price)` : ''}${d.incomplete ? ` · ${d.incomplete} cards use an unpriced ingredient` : ''}`}
          onGo={onGo}
        />
        <KpiTile
          to="margin"
          cls={d.over ? 'w' : 'g'}
          k="Over Target"
          v={d.over}
          n={`of ${d.priced} priced items`}
          onGo={onGo}
        />
        <KpiTile
          to="menu"
          cls={d.loss ? 'r' : 'g'}
          k="Selling At A Loss"
          v={d.loss}
          n="negative net profit"
          onGo={onGo}
        />
        <KpiTile to="menu" k="Locked & Approved" v={d.locked} n={`of ${d.total} cards`} onGo={onGo} />
        <KpiTile
          to="ingredients"
          cls={d.flagged ? 'w' : ''}
          k="Ingredients"
          v={d.items}
          n={`${d.flagged} flagged, ${d.noPrice} unpriced`}
          onGo={onGo}
        />
      </div>

      <div className="dash-ov">
        <OverviewCard title="Food cost vs target" onOpen={() => onGo('menu')}>
          <div style={s('display:flex;gap:16px;align-items:center;flex-wrap:wrap')}>
            <FoodCostGauge avg={d.avgFC} target={t} excluded={d.excluded} />
            <FoodCostSpread bins={a.spread} target={t} />
          </div>
        </OverviewCard>

        <OverviewCard title="Menu Matrix" onOpen={() => onGo('menu')}>
          {a.matrix.points ? (
            <MatrixScatter
              points={a.matrix.points}
              popCut={a.matrix.popularityCut ?? 0}
              marCut={a.matrix.marginCut ?? 0}
            />
          ) : (
            <div className="note">
              Needs {MATRIX_MIN_ITEMS} classified items; {a.matrix.classified} so far.
            </div>
          )}
        </OverviewCard>

        <OverviewCard title="Margin at Risk" onOpen={() => onGo('margin')}>
          <RiskBars total={a.risk.total} count={a.risk.count} rows={a.risk.rows} unpriced={a.unpriced} />
        </OverviewCard>

        <OverviewCard title="Cost Drivers" onOpen={() => onGo('ingredients')}>
          <DriverBars rows={a.drivers.rows} count={a.drivers.count} />
        </OverviewCard>

        <OverviewCard title="Theoretical vs Actual" onOpen={() => onGo('ingredients')}>
          <TvaHeadline t={a.tva} />
        </OverviewCard>

        <OverviewCard title="Performance by Brand" onOpen={() => onGo('brands')}>
          <BrandBars rows={d.byBrand} target={t} />
        </OverviewCard>
      </div>
    </>
  );
}

/** Menu tab, upper part: the Highest Food Cost cards (top 25), as before. */
function TopCardsTable({
  d,
  brandNames,
  open,
}: {
  d: DashData;
  brandNames: Record<string, string>;
  open: (id: string) => void;
}) {
  const router = useRouter();
  const t = d.target;
  return (
    <>
      <div style={s('display:flex;align-items:baseline;gap:10px;margin-bottom:10px;flex-wrap:wrap')}>
        <h3 style={sectionH3}>{d.totalMenus > TOP ? `Highest Food Cost · top ${TOP}` : 'All Menu Items'}</h3>
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
                  <td style={s('min-width:180px')}>
                    <b>{r.name}</b>
                    <div style={s('font-size:11px;color:var(--mute)')}>{r.cat || ''}</div>
                  </td>
                  <td>
                    {r.brandId ? (
                      <span className="pill p-sub" style={s('white-space:nowrap')}>
                        {brandNames[r.brandId] ?? ''}
                      </span>
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
                  <td className="n" style={{ color: c.sp && c.net < 0 ? 'var(--bad)' : undefined, fontWeight: 600 }}>
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
    </>
  );
}

/** Brands tab: Performance by Brand, as before. */
function BrandsTable({ d }: { d: DashData }) {
  const t = d.target;
  return (
    <>
      <h3 style={sectionH3}>Performance by Brand</h3>
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
                  <td style={s('white-space:nowrap')}>
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
                    {g.over ? <span className="pill p-warn">{g.over}</span> : <span className="pill p-ok">0</span>}
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
  );
}

/** Brands tab: Sub-Recipes (first 20), as before. */
function SubRecipesTable({ d, open }: { d: DashData; open: (id: string) => void }) {
  return (
    <>
      <h3
        style={{
          ...s('font-size:13px;letter-spacing:.05em;text-transform:uppercase;color:var(--grn-dk);margin:22px 0 10px'),
        }}
      >
        Sub-Recipes{d.subs > TOP_SUB ? ` · first ${TOP_SUB} of ${d.subs}` : ''}
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
                    <span className="pill p-sub" style={s('white-space:nowrap')}>
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
  );
}
