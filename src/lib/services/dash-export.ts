import type { Catalog } from '../db/catalog';
import type { Queryable } from '../db/client';
import { parseValue } from '../http';
import type { PageCtx } from '../screens/ctx';
import { dashFilters, loadDashAnalytics } from './dash';
import type { ExportFile, ExportQuery } from './exports';

const VERDICT = { within: 'Within allowance', over: 'Over', under: 'Under (20% tolerance)' } as const;
const TVA_STATE = { counted: 'compared', 'no-count': 'no opening/closing count', shared: 'shared site' } as const;
const TVA_REASON = {
  client: 'stock is not tracked per client',
  range: 'pick a from and to date to compare with stock counts',
  'no-count': 'no site has both an opening and a closing count in the range',
  shared: 'stock covers the whole site, and another brand uses it',
} as const;
const QUADRANT = { star: 'Star', plowhorse: 'Plowhorse', puzzle: 'Puzzle', dog: 'Dog' } as const;
const f = (v: number, d: number) => v.toFixed(d);
const pc = (v: number) => f(v * 100, 1);

/**
 * The dashboard export (D-67): the same loader as the screen, so the file always matches what the filters show.
 * Sections are separated by a blank row and start with a title row; the filters are echoed first. Every cell goes
 * through csvLine (D-36), including the echoed filter values.
 */
export async function dashExportRows(
  db: Queryable,
  ctx: PageCtx,
  catalog: Catalog,
  q: ExportQuery,
): Promise<ExportFile> {
  const filters = parseValue({ brand: q.brand, loc: q.loc, client: q.client, from: q.from, to: q.to }, dashFilters);
  const d = await loadDashAnalytics(db, ctx, catalog, filters, undefined, { full: true });
  const brandName = filters.brand === '*' ? 'All brands' : (ctx.brands.find((b) => b.id === filters.brand)?.name ?? '');
  const out: unknown[][] = [
    ['Dashboard analytics'],
    ['Brand', brandName],
    ['Site', filters.loc === '*' ? 'All sites' : filters.loc],
    [
      'Client',
      filters.client === '*'
        ? 'All clients'
        : filters.client === 'none'
          ? 'Unassigned'
          : (d.clientOptions.find((c) => c.id === filters.client)?.name ?? ''),
    ],
    ['From', filters.from ?? 'start'],
    ['To', filters.to ?? 'latest'],
    ['Portions in range', d.portions],
    ['Target food cost %', pc(d.target)],
  ];

  out.push([], ['Menu Matrix (popularity vs contribution per portion)']);
  const m = d.matrix;
  if (!m.points) out.push([`Not enough data to classify yet (${m.classified} of 4 needed)`]);
  else {
    out.push(['Popularity cut (portions)', f(m.popularityCut!, 4), 'Contribution cut', f(m.marginCut!, 4)]);
    out.push(['Code', 'Name', 'Portions', 'Share %', 'Contribution per portion', 'Class']);
    for (const p of m.points)
      out.push([p.code, p.name, f(p.portions, 4), pc(p.share), f(p.contribution, 4), QUADRANT[p.quadrant]]);
  }
  out.push([
    'Not classified: no selling price',
    m.unpriced,
    'no production in range',
    m.noProduction,
    'cost could not be valued',
    m.unvalued,
  ]);

  out.push([], ['Margin at risk']);
  out.push(['Code', 'Name', 'Portions', 'Food cost %', 'Over target per portion', 'At risk']);
  for (const r of d.risk.rows)
    out.push([r.code, r.name, f(r.portions, 4), pc(r.fcPct), f(r.overPerPortion, 4), f(r.atRisk, 2)]);
  out.push(['Total at risk', '', '', '', '', f(d.risk.total, 2)]);

  out.push([], ['Over target (current cost, brand filter only)']);
  out.push(['Code', 'Name', 'Food cost %', 'Points over target']);
  for (const r of d.overTarget) out.push([r.code, r.name, pc(r.fcPct), pc(r.gap)]);

  out.push([], ['Cost drivers (issue value, excl. waste buffer)']);
  out.push(['Code', 'Ingredient', 'Unit', 'Purchase quantity', 'Cost', 'Share %', 'Cumulative %', 'Class']);
  for (const r of d.drivers.rows)
    out.push([
      r.item.code,
      r.item.name,
      r.item.uom,
      f(r.item.purchaseQty, 4),
      f(r.cost, 4),
      pc(r.share),
      pc(r.cumulative),
      r.cls,
    ]);

  out.push([], ['Unpriced exposure (produced cards that reach an ingredient with no price)']);
  out.push(['Code', 'Name', 'Portions', 'Unpriced ingredients']);
  for (const r of d.unpriced.rows) out.push([r.code, r.name, f(r.portions, 4), r.missing]);

  const t = d.tva;
  out.push([], ['Theoretical vs actual usage (purchase units; theoretical = requisition usage without waste buffer)']);
  out.push([
    t.mode === 'actual'
      ? `Compared: ${t.counted} of ${t.total} site(s) with an opening and a closing count`
      : `Theoretical only: ${TVA_REASON[t.reason ?? 'no-count']}`,
  ]);
  for (const s of t.sites)
    out.push([
      'Site',
      s.site,
      TVA_STATE[s.state],
      s.state === 'counted' ? `after ${s.from} up to and including ${s.to}` : '',
    ]);
  if (t.unallocated)
    out.push([
      'Production with no site (not compared)',
      f(t.unallocated.portions, 4),
      'theoretical value',
      f(t.unallocated.value, 2),
      'ingredients without a price',
      t.unallocated.unpriced,
    ]);
  out.push([
    'Code',
    'Ingredient',
    'Unit',
    'Theoretical',
    'Allowed up to',
    'Actual',
    'Deviation',
    'Deviation value',
    'Verdict',
    'Note',
  ]);
  for (const r of t.rows)
    out.push([
      r.code,
      r.name,
      r.uom,
      f(r.theoretical, 4),
      f(r.ceiling, 4),
      r.actual === null ? 'n/a' : f(r.actual, 4),
      r.deviation === null ? 'n/a' : f(r.deviation, 4),
      r.value === null ? (r.deviation === null ? 'n/a' : 'no price') : f(r.value, 2),
      r.verdict ? VERDICT[r.verdict] : 'n/a',
      r.flagged ? 'unconvertible unit on a recipe line: usage understated' : '',
    ]);

  const dataRows =
    t.rows.length +
    (d.matrix.points?.length ?? 0) +
    d.risk.rows.length +
    d.overTarget.length +
    d.drivers.rows.length +
    d.unpriced.rows.length;
  const tag = (s: string) => s.replace(/[^\w-]+/g, '-');
  return {
    filename: `dashboard-${tag(filters.from ?? 'start')}_${tag(filters.to ?? 'latest')}.csv`,
    rows: out,
    dataRows,
  };
}
