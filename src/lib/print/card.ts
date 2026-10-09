/**
 * Recipe card print markup — port of legacy buildCardHTML (5986). Pure: returns an HTML string with every dynamic value
 * escaped; images are URLs here (the page prints them directly) and are inlined as data URLs for Blob documents
 * (docs/UI_PORT.md §3). D-21: the "Variable buffer" label shows the effective rate (amount / cost), not the global buffer.
 */
import { brandVars } from '../brand/palette';
import { cur, pct } from '../format';

export function esc(s: unknown): string {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m] as string,
  );
}

export interface PrintLine {
  code: string;
  name: string;
  uom: string;
  qty: number;
  unit: string;
  y: number;
  price: number;
  cost: number;
  kind: string;
}

export interface PrintCost {
  batch: number;
  err: string;
  out: number;
  orig: number;
  food: number;
  pkg: number;
  del: number;
  lab: number;
  ops: number;
  totalCost: number;
  net: number;
  sp: number;
  fcPct: number | null;
  npPct: number | null;
  gramTotal: number;
  mlTotal: number;
  eaTotal: number;
  bOut: number;
  bUom: string;
  portion: number;
  suggest: number;
  vatPrice: number;
}

export interface PrintCard {
  name: string;
  code: string;
  cat: string;
  type: 'MENU' | 'SUB';
  status: 'DRAFT' | 'LOCKED';
  lockedBy: string | null;
  brand: { name: string; nameAr: string | null; color: string; ink: string | null } | null;
  logoUrl: string;
  photoUrl: string | null;
  lines: PrintLine[];
  method: string[];
  c: PrintCost;
  settings: { currency: string; pkg: number; del: number; lab: number; ops: number; buffer: number; target: number; vat: number; priceDate: string };
  printedOn: string;
}

const AR_CO = 'الشركة العالمية التخصصية للأغذية';

export function buildCardHTML(r: PrintCard): string {
  const c = r.c;
  const st = r.settings;
  const cu = esc(st.currency || '');
  const d = (k: string, v: string | number, cls?: string) => `<tr class="${cls || ''}"><td class="l">${k}</td><td class="v">${v}</td></tr>`;
  const lines = r.lines.filter((l) => l.code);
  const dp = c.bUom === 'Each' ? 0 : 1;
  // D-21: effective variable buffer rate (what the card actually adds), falling back to the global rate on a zero-cost card
  const eff = c.orig > 0 ? c.food / c.orig - 1 : st.buffer;
  const brandColor = r.brand?.color || '#BB5E1E';
  const steps = r.method.filter((m) => m && m.trim());

  return `<div class="pc" style="${brandVars(r.brand ? { color: r.brand.color, ink: r.brand.ink } : null)}">

  <div class="ph">
    ${r.photoUrl ? `<img class="dish" src="${esc(r.photoUrl)}" alt="">` : ''}
    <img src="${esc(r.logoUrl)}" alt="">
    <div class="phx">
      <h2>${esc(r.name || 'Untitled Recipe')}</h2>
      <div class="co">International Specialized Food Co. &nbsp;•&nbsp;
        ${AR_CO}</div>
      <div class="mt">${
        r.brand
          ? `<b style="color:${esc(brandColor)}">${esc(r.brand.name)}${r.brand.nameAr ? ' – ' + esc(r.brand.nameAr) : ''}</b> &nbsp;•&nbsp; `
          : ''
      }<b>${esc(r.code || 'no code')}</b>
        &nbsp;•&nbsp; ${esc(r.cat || 'Uncategorised')}
        &nbsp;•&nbsp; ${r.type === 'SUB' ? 'Sub-Recipe' : 'Menu Item'}
        ${r.status === 'LOCKED' ? `&nbsp;•&nbsp; <b style="color:#8F4716">APPROVED${r.lockedBy ? ' – ' + esc(r.lockedBy) : ''}</b>` : '&nbsp;•&nbsp; <b style="color:#C0392B">DRAFT</b>'}</div>
    </div>
    <div class="pho">
      <div class="k">BATCH OUTPUT</div>
      <div class="v">${cur(c.bOut, dp)} <span>${esc(c.bUom)}</span></div>
      <div class="s">${c.out} portion${c.out === 1 ? '' : 's'} &nbsp;•&nbsp;
        ${cur(c.portion, dp)} ${esc(c.bUom)} per portion</div>
    </div>
  </div>

  <table class="ing">
    <colgroup>
      <col style="width:13%"><col style="width:29%"><col style="width:7%"><col style="width:9%">
      <col style="width:8%"><col style="width:7%"><col style="width:13%"><col style="width:14%">
    </colgroup>
    <thead><tr>
      <th>Code</th><th>Item Name</th><th class="ctr">UOM</th><th class="num">Qty</th>
      <th class="ctr">Unit</th><th class="num">Yield</th>
      <th class="num">Unit Price</th><th class="num">Line Cost</th>
    </tr></thead>
    <tbody>
    ${lines
      .map(
        (x) => `<tr>
      <td class="cd">${esc(x.code)}</td>
      <td>${esc(x.name)}${x.kind === 'sub' ? ' <b style="color:#3E8C1C">(sub-recipe)</b>' : ''}</td>
      <td class="ctr">${esc(x.uom)}</td>
      <td class="num">${cur(x.qty, 2)}</td>
      <td class="ctr">${esc(x.unit)}</td>
      <td class="num">${(x.y * 100).toFixed(0)}%</td>
      <td class="num">${cur(x.price, 6)}</td>
      <td class="num">${cur(x.cost, 3)}</td></tr>`,
      )
      .join('')}
    ${lines.length ? '' : '<tr><td colspan="8" style="padding:12pt;text-align:center;color:#8A7B6D">No ingredients recorded</td></tr>'}
    </tbody>
    <tfoot><tr>
      <td colspan="3">BATCH TOTAL &nbsp;–&nbsp; ${lines.length} ingredient${lines.length === 1 ? '' : 's'}</td>
      <td class="num">${cur(c.gramTotal + c.mlTotal + c.eaTotal, 2)}</td>
      <td colspan="3"></td>
      <td class="num">${cur(c.batch, 3)}</td>
    </tr></tfoot>
  </table>

  <table class="sum"><tr>
    <td><div class="blk"><h4>Cost Build-Up &nbsp;·&nbsp; Per Portion</h4><table>
      ${d('Batch cost', cur(c.batch, 3))}
      ${d('Batch output', cur(c.bOut, dp) + ' ' + esc(c.bUom))}
      ${d('Portions produced', c.out)}
      ${d('Portion size', cur(c.portion, dp) + ' ' + esc(c.bUom))}
      ${d('Original cost / portion', cur(c.orig, 3))}
      ${d('Variable buffer ' + pct(eff), cur(c.food - c.orig, 3))}
      ${d('FOOD COST', cur(c.food, 3), 'tot')}
    </table></div></td>

    <td><div class="blk"><h4>Charges &nbsp;·&nbsp; Per Portion</h4><table>
      ${d('Packaging ' + pct(st.pkg), cur(c.pkg))}
      ${d('Delivery ' + pct(st.del), cur(c.del))}
      ${d('Labor ' + pct(st.lab), cur(c.lab))}
      ${d('OPS ' + pct(st.ops), cur(c.ops))}
      ${d('Food cost', cur(c.food))}
      ${d('TOTAL COST', cur(c.totalCost), 'tot')}
    </table></div></td>

    <td><div class="blk g"><h4>Selling Position &nbsp;·&nbsp; Per Portion</h4><table>
      ${d('Price excl VAT', cur(c.sp))}
      ${d('VAT ' + pct(st.vat), cur(c.vatPrice - c.sp))}
      ${d('Price incl VAT', cur(c.vatPrice))}
      ${d('Food cost achieved', pct(c.fcPct))}
      ${d('Target food cost', pct(st.target))}
      ${d('Price at target FC', cur(c.suggest))}
      ${d('Net margin', pct(c.npPct))}
      ${d('NET PROFIT', cur(c.net), 'tot g')}
    </table></div></td>
  </tr></table>

  ${c.err ? `<div class="warn">INCOMPLETE COSTING: ${esc(c.err)} – do not price from this card until it is resolved.</div>` : ''}

  ${
    steps.length
      ? `<div class="meth">
    <h4>COOKING METHOD</h4>
    <ol>${steps.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>
  </div>`
      : ''
  }

  <table class="sig"><tr>
    <td>
      <div class="lbl">CHEF SIGNATURE</div>
      <div class="ln"></div><div class="cap">Name and signature</div>
      <div class="dt"><span>Date</span><span class="ln"></span></div>
    </td>
    <td>
      <div class="lbl">GENERAL MANAGER APPROVAL</div>
      <div class="ln"></div><div class="cap">Name and signature</div>
      <div class="dt"><span>Date</span><span class="ln"></span></div>
    </td>
  </tr></table>
  <div class="foot">All amounts in ${cu || 'local currency'} &nbsp;•&nbsp;
    Purchase prices effective ${esc(st.priceDate)} &nbsp;•&nbsp;
    Printed ${esc(r.printedOn)} &nbsp;•&nbsp;
    International Specialized Food Co.</div>
  </div>`;
}
