/** Production / store / preparation sheets — ports of legacy prodHead..prodDoc (2334-2405) and prepDoc (1859). Pure HTML builders. */
import { cur } from '../format';
import { esc } from './card';

export interface SheetRow {
  code: string;
  name: string;
  uom: string;
  qty: number;
  from: Record<string, number>;
}
export interface SheetRecipe {
  code: string;
  name: string;
  portions: number;
  rows: SheetRow[];
}
export interface SheetData {
  brand: string;
  site: string;
  month: string;
  day: string;
  weekday: string;
  /** sections that have anything to cook, in legacy order */
  sections: { key: string; en: string; ar: string; recipes: SheetRecipe[] }[];
  /** consolidated store list */
  store: SheetRow[];
}

function head(d: SheetData, title: string): string {
  return `<div class="ph"><div class="t">${esc(title)}</div>
    <div class="m">${esc(d.brand)}${d.site ? ' · ' + esc(d.site) : ''} · ${esc(d.month)}-${esc(d.day)}
      · ${esc(d.weekday)}</div></div>`;
}

function sectionSheet(d: SheetData, key: string): string {
  const s = d.sections.find((x) => x.key === key);
  if (!s || !s.recipes.length) return '';
  const rows = [...s.recipes]
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map((r) => {
      const ing = [...r.rows]
        .sort((a, b) => b.qty - a.qty)
        .map((e) => `${esc(e.name)} <b>${cur(e.qty, 0)}</b>${esc(e.uom === 'Each' ? '' : e.uom.toLowerCase())}`)
        .join(' · ');
      return `<tr><td class="d"><b>${esc(r.name)}</b>
        <div class="c">${esc(r.code)}</div></td>
      <td class="q"><span class="big">${r.portions}</span><div class="c">portions</div></td>
      <td class="i">${ing}</td>
      <td class="s"></td></tr>`;
    })
    .join('');
  return `${head(d, s.en + '  ·  ' + s.ar)}
    <table><thead><tr><th>Dish</th><th style="width:80px">Cook</th>
      <th>Raw material to draw</th><th style="width:90px">Done</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <div class="f">Prepared by ______________  Checked by ______________  Time ________</div>`;
}

function storeSheet(d: SheetData): string {
  if (!d.store.length) return '';
  const rows = [...d.store]
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(
      (e) => `<tr><td class="d"><b>${esc(e.name)}</b>
      <div class="c">${esc(e.code)}</div></td>
    <td class="q"><span class="big">${cur(e.qty, 0)}</span> ${esc(e.uom)}</td>
    <td class="i">${esc(Object.keys(e.from).join(', '))}</td>
    <td class="s"></td></tr>`,
    )
    .join('');
  return `${head(d, 'Store requisition')}
    <table><thead><tr><th>Raw material</th><th style="width:120px">Issue</th>
      <th>For</th><th style="width:90px">Issued</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="f">Issued by ______________  Received by ______________  Time ________</div>`;
}

/** Legacy prodDoc(kind): kind = a section key, 'store' or 'all'. Empty string when there is nothing to print. */
export function prodDoc(kind: string, d: SheetData): string {
  let body = '';
  if (kind === 'store') body = storeSheet(d);
  else if (kind === 'all') {
    body = d.sections
      .map((s) => sectionSheet(d, s.key))
      .filter(Boolean)
      .join('<div class="pb"></div>');
    const st = storeSheet(d);
    if (st) body += (body ? '<div class="pb"></div>' : '') + st;
  } else body = sectionSheet(d, kind);
  if (!body) return '';
  return `<!doctype html><html><head><meta charset="utf-8">
    <title>Production ${esc(d.month)}-${esc(d.day)}</title><style>
    *{box-sizing:border-box}
    body{font:13px/1.45 Arial,Helvetica,sans-serif;color:#141414;margin:14mm 10mm}
    .ph{border-bottom:2px solid #471729;padding-bottom:6px;margin:0 0 10px}
    .ph .t{font-size:19px;font-weight:700;color:#471729}
    .ph .m{font-size:12px;color:#6b5a60;margin-top:2px}
    table{width:100%;border-collapse:collapse;margin-bottom:8px}
    th{background:#471729;color:#fff;font-size:11px;text-align:left;padding:6px 7px}
    td{border-bottom:1px solid #ddd;padding:7px;vertical-align:top}
    td.q{text-align:center;white-space:nowrap}
    .big{font-size:19px;font-weight:700;color:#8a3b12}
    td.c,.c{font-size:10px;color:#8a7c81;font-weight:400}
    td.i{font-size:11.5px;color:#3b3b3b}
    td.s{border-bottom:1px solid #ddd;background:#fafafa}
    .f{font-size:11px;color:#6b5a60;margin-top:14px;padding-top:8px;border-top:1px solid #ddd}
    .pb{page-break-after:always}
    @media print{body{margin:0}@page{margin:12mm}}
    </style></head><body>${body}</body></html>`;
}

export interface PrepSheetData {
  site: string;
  weekday: string;
  people: number;
  dishes: number;
  menus: { name: string; pax: number; dishes: number }[];
  rows: { code: string; name: string; uom: string; qty: number }[];
  printedAt: string;
  /** the page CSS (legacy copied every <style> of the live page) */
  css: string;
}

/** Legacy prepDoc (1859): the store requisition printed from the Preparation screen. */
export function prepDoc(d: PrepSheetData): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Store requisition</title>
   <style>${d.css}\nbody{background:#fff;padding:14mm 11mm;font-family:Arial,Helvetica,sans-serif}
   table{width:100%;border-collapse:collapse;font-size:9pt}
   th{background:var(--org-lt);color:var(--org-dk);text-align:left;padding:4pt 5pt;font-size:7.5pt;
      letter-spacing:.06em;text-transform:uppercase}
   td{padding:3.5pt 5pt;border-bottom:.5pt solid var(--line)}
   .n{text-align:right}
   h1{font-size:15pt;margin:0 0 2pt}.sub{font-size:8.5pt;color:var(--mute);margin-bottom:10pt}
   h2{font-size:10pt;margin:14pt 0 5pt;padding-bottom:3pt;border-bottom:1.5pt solid var(--org)}
   .sig{margin-top:16pt;width:100%}.sig td{border:0;padding-top:18pt;font-size:8pt}
   @page{size:A4 portrait;margin:13mm 11mm}</style></head><body>
   <h1>Store requisition</h1>
   <div class="sub">${esc(d.site)} &nbsp;•&nbsp;
     ${esc(d.weekday.charAt(0) + d.weekday.slice(1).toLowerCase())} &nbsp;•&nbsp;
     ${cur(d.people, 0)} people &nbsp;•&nbsp; ${d.dishes} dishes &nbsp;•&nbsp;
     printed ${esc(d.printedAt)}</div>
   <h2>Menus</h2>
   <table><thead><tr><th>Menu</th><th class="n">People</th><th class="n">Dishes</th></tr></thead><tbody>
   ${d.menus
     .map(
       (m) => `<tr><td>${esc(m.name)}</td><td class="n">${cur(m.pax, 0)}</td>
     <td class="n">${m.dishes}</td></tr>`,
     )
     .join('')}
   </tbody></table>
   <h2>Raw materials</h2>
   <table><thead><tr><th>Code</th><th>Raw material</th><th>Unit</th>
     <th class="n">Quantity</th><th style="width:52pt">Issued</th></tr></thead><tbody>
   ${d.rows
     .map(
       (x) => `<tr><td>${esc(x.code)}</td><td>${esc(x.name)}</td><td>${esc(x.uom || '')}</td>
     <td class="n"><b>${cur(x.qty, 2)}</b></td><td></td></tr>`,
     )
     .join('')}
   </tbody><tfoot><tr><td colspan="4" style="font-weight:700;padding-top:5pt">
     TOTAL · ${d.rows.length} materials</td><td></td></tr></tfoot></table>
   <table class="sig"><tr><td style="width:50%">Requested by ______________________</td>
     <td>Issued by ______________________</td></tr></table>
   </body></html>`;
}
