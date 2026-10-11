'use client';

import type { CSSProperties, ReactNode } from 'react';
import { s } from '@/components/ui';
import type { FcBin, MatrixPoint, ParetoRow, Quadrant, RiskRow } from '@/domain/dash-analytics';
import { cur, fcBar, fcClass, pct } from '@/lib/format';
import type { DashAnalytics, DriverRow } from '@/lib/services/dash';
import type { DashData } from '@/lib/screens/dash';

/** Quadrant colours and names (Menu Matrix, D-66). Colour is always paired with a count and a name. */
export const QUAD: Record<Quadrant, { title: string; sub: string; color: string }> = {
  puzzle: { title: 'Puzzles', sub: 'Unpopular, high margin', color: 'var(--org-dk)' },
  star: { title: 'Stars', sub: 'Popular, high margin', color: 'var(--grn-dk)' },
  dog: { title: 'Dogs', sub: 'Unpopular, low margin', color: 'var(--bad)' },
  plowhorse: { title: 'Plowhorses', sub: 'Popular, low margin', color: 'var(--mute)' },
};
export const QUAD_ORDER: Quadrant[] = ['puzzle', 'star', 'dog', 'plowhorse'];

/** Why Theoretical vs Actual has no verdicts (D-74); the same wording as the Ingredients tab. */
export const TVA_REASON: Record<string, string> = {
  client: 'Stock is not tracked per client, so only theoretical usage is shown.',
  range: 'Pick a From and To date to compare with stock counts.',
  'no-count': 'No site has both an opening and a closing count in this range, so only theoretical usage is shown.',
  shared: 'Stock covers the whole site and another brand uses it, so only theoretical usage is shown.',
};

/** Small card heading, the same look as the section headings. */
export const CARD_H3: CSSProperties = s(
  'font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--org-dk);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
);

const ROW: CSSProperties = s('display:grid;gap:8px;align-items:center;font-size:12px');
const CLIP: CSSProperties = s('overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0');
const MUTE: CSSProperties = s('font-size:12px;color:var(--mute)');

/**
 * One overview card: a heading, a "View details" button that opens the detail tab for this data, and the graphic.
 * The whole card is not clickable; only the button is, so the card keeps its own text selectable.
 */
export function OverviewCard({ title, onOpen, children }: { title: string; onOpen: () => void; children: ReactNode }) {
  return (
    <section className="card" style={s('padding:12px 14px;min-width:0;display:flex;flex-direction:column;gap:10px')}>
      <div style={s('display:flex;justify-content:space-between;align-items:center;gap:8px')}>
        <h3 style={CARD_H3}>{title}</h3>
        <button type="button" className="btn sm o" onClick={onOpen}>
          View details
        </button>
      </div>
      {children}
    </section>
  );
}

function Key({ color, children }: { color: string; children: ReactNode }) {
  return (
    <li style={s('display:flex;align-items:center;gap:6px')}>
      <i style={{ width: 9, height: 9, borderRadius: 2, background: color, flex: 'none' }} />
      <span>{children}</span>
    </li>
  );
}

/**
 * Food cost vs target, the average as a gauge (0 to twice the target, so the target sits at the top of the arc, the
 * same scale as the legacy bars). Cards with no selling price are left out of the average and counted under it.
 */
export function FoodCostGauge({ avg, target, excluded }: { avg: number | null; target: number; excluded: number }) {
  const b = fcBar(avg, target);
  return (
    <div style={s('text-align:center;flex:none')}>
      <svg
        viewBox="0 0 150 96"
        width="150"
        role="img"
        aria-label={`Average food cost ${pct(avg)}, target ${pct(target)}`}
        style={s('display:block;height:auto;max-width:100%')}
      >
        <path d="M13 80 A62 62 0 0 1 137 80" pathLength={100} fill="none" stroke="var(--line)" strokeWidth={12} />
        <path
          d="M13 80 A62 62 0 0 1 137 80"
          pathLength={100}
          fill="none"
          stroke={b.col}
          strokeWidth={12}
          strokeDasharray={`${b.w} 100`}
        />
        <line x1="75" y1="8" x2="75" y2="22" stroke="var(--mute)" strokeWidth={2} />
        <text x="75" y="72" textAnchor="middle" fontSize="20" fontWeight="700" fill="currentColor">
          {pct(avg)}
        </text>
      </svg>
      <div style={MUTE}>target {pct(target)}</div>
      {excluded > 0 && <div style={MUTE}>{excluded} not priced</div>}
    </div>
  );
}

const roundPct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Food-cost spread (D-84): portions produced per food-cost band, split into within and over the target. Weighted by
 * portions, as chosen; each card is counted once in the split by its own status, so the colours are exact.
 */
export function FoodCostSpread({ bins, target }: { bins: FcBin[]; target: number }) {
  const total = bins.reduce((a, b) => a + b.within + b.over, 0);
  if (total <= 0) return <div className="note">No production in this range, so there is nothing to spread.</div>;
  const cards = bins.reduce((a, b) => a + b.cards, 0);
  const within = bins.reduce((a, b) => a + b.within, 0);
  const over = bins.reduce((a, b) => a + b.over, 0);
  const max = Math.max(...bins.map((b) => b.within + b.over));
  const W = 220;
  const H = 112;
  const B = 18;
  const T = 6;
  const slot = W / bins.length;
  const hgt = (v: number) => (v / max) * (H - T - B);
  return (
    <div style={s('flex:1 1 220px;min-width:0')}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Food-cost spread by portions: ${cards} cards with production, target ${pct(target)}`}
        style={s('display:block;height:auto')}
      >
        {bins.map((b, i) => {
          const x = i * slot + 2;
          const w = slot - 4;
          const hw = hgt(b.within);
          const ho = hgt(b.over);
          const range = b.to === null ? `${roundPct(b.from)} and over` : `${roundPct(b.from)} to ${roundPct(b.to)}`;
          return (
            <g key={i}>
              <title>{`${range}: ${b.cards} card${b.cards === 1 ? '' : 's'}, ${Math.round(b.within)} portions within, ${Math.round(b.over)} over`}</title>
              <rect x={x} y={H - B - hw} width={w} height={hw} fill="var(--grn)" />
              <rect x={x} y={H - B - hw - ho} width={w} height={ho} fill="var(--bad)" />
            </g>
          );
        })}
        <line x1={0} x2={W} y1={H - B} y2={H - B} stroke="var(--line)" />
        {bins.map(
          (b, i) =>
            i % 2 === 0 && (
              <text key={i} x={i * slot + 2} y={H - 4} fontSize="9" fill="var(--mute)">
                {Math.round(b.from * 100)}%{b.to === null ? '+' : ''}
              </text>
            ),
        )}
      </svg>
      <ul style={s('list-style:none;margin:6px 0 0;padding:0;font-size:12px;display:flex;flex-wrap:wrap;gap:4px 12px')}>
        <Key color="var(--grn)">{Math.round(within)} portions within target</Key>
        <Key color="var(--bad)">{Math.round(over)} over target</Key>
      </ul>
      <div style={MUTE}>Portions by food cost %, {cards} cards with production</div>
    </div>
  );
}

/**
 * Menu Matrix as a scatter: portions (x) against margin per portion (y), with the two cut lines. Each dot is a card;
 * its title carries the code, name and figures. The legend gives the count per quadrant in words.
 */
export function MatrixScatter({ points, popCut, marCut }: { points: MatrixPoint[]; popCut: number; marCut: number }) {
  const W = 300;
  const H = 168;
  const L = 30;
  const R = 8;
  const T = 8;
  const B = 20;
  const maxX = Math.max(popCut, ...points.map((p) => p.portions), 1);
  const minY = Math.min(0, ...points.map((p) => p.contribution));
  const maxY = Math.max(marCut, ...points.map((p) => p.contribution), 1);
  const span = maxY - minY || 1;
  const X = (v: number) => L + (v / maxX) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - minY) / span) * (H - T - B);
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="Menu Matrix: portions against margin per portion"
        style={s('display:block;height:auto')}
      >
        <line x1={X(popCut)} x2={X(popCut)} y1={T} y2={H - B} stroke="var(--mute)" strokeDasharray="3 3" />
        <line x1={L} x2={W - R} y1={Y(marCut)} y2={Y(marCut)} stroke="var(--mute)" strokeDasharray="3 3" />
        <line x1={L} x2={L} y1={T} y2={H - B} stroke="var(--line)" />
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="var(--line)" />
        {points.map((p) => (
          <circle
            key={p.code}
            cx={X(p.portions)}
            cy={Y(p.contribution)}
            r={4.5}
            fill={QUAD[p.quadrant].color}
            stroke="#fff"
            strokeWidth={1}
          >
            <title>{`${p.code} ${p.name}: ${p.portions} portions, ${cur(p.contribution)} per portion`}</title>
          </circle>
        ))}
        <text x={W - R} y={H - 5} textAnchor="end" fontSize="9" fill="var(--mute)">
          portions
        </text>
        <text x={L + 3} y={T + 9} fontSize="9" fill="var(--mute)">
          margin/portion
        </text>
      </svg>
      <div style={s('display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;margin-top:6px')}>
        {QUAD_ORDER.map((q) => (
          <span key={q} style={s('display:inline-flex;align-items:center;gap:5px')}>
            <i style={{ width: 9, height: 9, borderRadius: '50%', background: QUAD[q].color }} />
            {points.filter((p) => p.quadrant === q).length} {QUAD[q].title}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Margin at Risk: the total, the five largest rows as bars, and the unpriced exposure line. */
export function RiskBars({
  total,
  count,
  rows,
  unpriced,
}: {
  total: number;
  count: number;
  rows: RiskRow[];
  unpriced: { count: number; portions: number };
}) {
  const top = rows.slice(0, 5);
  const max = Math.max(...top.map((r) => r.atRisk), 1);
  return (
    <>
      <div style={s('display:flex;align-items:baseline;gap:8px;flex-wrap:wrap')}>
        <span style={s('font-size:24px;font-weight:700;letter-spacing:-.02em')}>{cur(total)}</span>
        <span style={MUTE}>
          over target across {count} card{count === 1 ? '' : 's'}
        </span>
      </div>
      {top.length === 0 ? (
        <div className="note">Nothing over target in this range.</div>
      ) : (
        top.map((r) => (
          <div key={r.code} style={{ ...ROW, gridTemplateColumns: '56px minmax(0,1fr) minmax(50px,80px) 70px' }}>
            <span className="mono">{r.code}</span>
            <span style={CLIP}>{r.name}</span>
            <div className="bar" style={s('min-width:0')}>
              <i style={{ width: `${(r.atRisk / max) * 100}%`, background: 'var(--warn)' }} />
            </div>
            <span style={s('text-align:right;font-weight:600')}>{cur(r.atRisk)}</span>
          </div>
        ))
      )}
      {unpriced.count > 0 && (
        <div style={MUTE}>
          {unpriced.count} card{unpriced.count === 1 ? '' : 's'} with unpriced ingredients, {unpriced.portions} portions
        </div>
      )}
    </>
  );
}

/** Cost Drivers: the top five ingredients by spend as bars, with the A/B/C class and the running share. */
export function DriverBars({ rows, count }: { rows: ParetoRow<DriverRow>[]; count: number }) {
  const top = rows.slice(0, 5);
  if (top.length === 0) return <div className="note">No production in this range.</div>;
  const max = Math.max(...top.map((r) => r.share), 0.0001);
  return (
    <>
      <div style={MUTE}>
        Top {top.length} of {count} ingredients
      </div>
      {top.map((r) => (
        <div key={r.item.code} style={{ ...ROW, gridTemplateColumns: 'minmax(0,1fr) minmax(50px,90px) 26px 52px' }}>
          <span style={CLIP}>
            <b>{r.item.name}</b>
          </span>
          <div className="bar" style={s('min-width:0')}>
            <i style={{ width: `${(r.share / max) * 100}%`, background: 'var(--org)' }} />
          </div>
          <span className={`pill ${r.cls === 'A' ? 'p-bad' : r.cls === 'B' ? 'p-warn' : 'p-gr'}`}>{r.cls}</span>
          <span style={s('text-align:right')}>{pct(r.cumulative)}</span>
        </div>
      ))}
    </>
  );
}

/**
 * Theoretical vs Actual: one stacked bar of the verdicts over the rows shown, with the counts as chips. Only the
 * stock-count mode has verdicts; theoretical mode says so instead of drawing empty bars.
 */
export function TvaHeadline({ t }: { t: DashAnalytics['tva'] }) {
  if (t.mode !== 'actual') {
    return <div className="note">{TVA_REASON[t.reason ?? 'no-count']}</div>;
  }
  const n = { within: 0, over: 0, under: 0, na: 0 };
  for (const r of t.rows) {
    if (r.verdict) n[r.verdict] += 1;
    else n.na += 1;
  }
  const all = t.rows.length || 1;
  const seg = (k: number) => `${(k / all) * 100}%`;
  return (
    <>
      <div style={MUTE}>
        {t.counted} of {t.total} sites counted
      </div>
      <div className="bar" style={s('display:flex;height:12px;min-width:0')}>
        <i style={{ width: seg(n.within), background: 'var(--grn)', display: 'block' }} />
        <i style={{ width: seg(n.under), background: 'var(--warn)', display: 'block' }} />
        <i style={{ width: seg(n.over), background: 'var(--bad)', display: 'block' }} />
        <i style={{ width: seg(n.na), background: 'var(--line)', display: 'block' }} />
      </div>
      <div style={s('display:flex;flex-wrap:wrap;gap:6px')}>
        <span className="pill p-ok">{n.within} within allowance</span>
        <span className="pill p-bad">{n.over} over</span>
        <span className="pill p-warn">{n.under} under</span>
        <span className="pill p-gr">{n.na} n/a</span>
      </div>
      {t.count > t.rows.length && (
        <div style={MUTE}>
          Counts cover the top {t.rows.length} of {t.count} ingredients
        </div>
      )}
    </>
  );
}

/** Performance by Brand: average food cost per brand against the target, with the over-target count. */
export function BrandBars({ rows, target }: { rows: DashData['byBrand']; target: number }) {
  return (
    <>
      {rows.map((g) => {
        const b = fcBar(g.afc, target);
        return (
          <div key={g.name} style={{ ...ROW, gridTemplateColumns: 'minmax(0,1fr) minmax(50px,90px) 56px' }}>
            <span style={{ minWidth: 0 }}>
              <b style={CLIP}>{g.name}</b>
              <span style={{ ...MUTE, display: 'block', ...CLIP }}>
                {g.n} card{g.n === 1 ? '' : 's'}, {g.over} over target
              </span>
            </span>
            <div className="bar" style={s('min-width:0')}>
              <i style={{ width: `${b.w}%`, background: b.col }} />
            </div>
            <span className={`pill ${fcClass(g.afc, target)}`} style={s('justify-self:end')}>
              {pct(g.afc)}
            </span>
          </div>
        );
      })}
    </>
  );
}
