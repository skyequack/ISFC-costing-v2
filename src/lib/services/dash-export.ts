import type { Catalog } from '../db/catalog';
import type { Queryable } from '../db/client';
import { parseValue } from '../http';
import type { PageCtx } from '../screens/ctx';
import { dashFilters, loadDashAnalytics } from './dash';
import type { ExportFile, ExportQuery } from './exports';

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
  const filters = parseValue({ brand: q.brand, loc: q.loc, from: q.from, to: q.to }, dashFilters);
  const d = await loadDashAnalytics(db, ctx, catalog, filters);
  const brandName = filters.brand === '*' ? 'All brands' : (ctx.brands.find((b) => b.id === filters.brand)?.name ?? '');
  const out: unknown[][] = [
    ['Dashboard analytics'],
    ['Brand', brandName],
    ['Site', filters.loc === '*' ? 'All sites' : filters.loc],
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

  const dataRows =
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
