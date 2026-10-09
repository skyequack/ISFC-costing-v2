'use client';

import type { useModal } from '@/components/shared/Modal';
import { s } from '@/components/ui';
import { cur, fcClass, pct } from '@/lib/format';
import type { RecipeDetail } from '@/lib/services/recipe-detail';

export function CostBreakdownButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="btn sm"
      style={s('white-space:nowrap')}
      onClick={onClick}
      title="Price every line from the raw material list and divide by this output"
    >
      {'Σ'} Calculate cost
    </button>
  );
}

const line = (label: React.ReactNode, value: React.ReactNode, note?: React.ReactNode, strong?: boolean) => (
  <tr key={String(label) + String(note)}>
    <td style={s('padding:4px 0')}>
      {strong ? <b>{label}</b> : label}
      {note ? <div style={s('font-size:11px;color:var(--mute)')}>{note}</div> : null}
    </td>
    <td className="n" style={s('padding:4px 0;white-space:nowrap')}>
      {strong ? <b>{value}</b> : value}
    </td>
  </tr>
);

/** Legacy costBreakdown (3273): the whole calculation on one screen. */
export function openBreakdown(
  modal: ReturnType<typeof useModal>,
  d: RecipeDetail,
  code: string,
  name: string,
  isSub: boolean,
  goItems: () => void,
) {
  const c = d.view.cost;
  const st = d.settings;
  const rows = d.recipe.lines.map((l, i) => ({ l, v: d.view.lines[i]! })).filter((x) => x.l.code);
  if (!rows.length) {
    modal.open({
      title: 'Calculate cost',
      body: <div className="note r">This card has no ingredient lines yet, so there is nothing to price.</div>,
    });
    return;
  }
  const unknown = rows.filter((x) => x.v.kind === 'none');
  const noPrice = rows.filter((x) => x.v.kind !== 'none' && !x.v.price);
  const needConv = rows.filter((x) => x.v.needConv);
  const pkgLines = rows.filter((x) => d.packaging.includes(x.l.code));
  const rate = d.recipe.buffer != null ? d.recipe.buffer : st.buffer;
  const pctRow = (label: string, r: number, value: number) =>
    line(
      <>
        {label} <span style={s('color:var(--mute)')}>{pct(r)}</span>
      </>,
      cur(value),
    );

  modal.open({
    title: `Cost of ${code ? code + ' – ' : ''}${name || 'this card'}`,
    body: (
      <>
        <div className="note" style={s('margin:0 0 12px')}>
          Every price below comes from the Ingredient Library, matched on the item code. Nothing is typed into this card.
        </div>
        {unknown.length > 0 && (
          <div className="note r" style={s('margin:0 0 10px')}>
            <b>
              {unknown.length} code{unknown.length === 1 ? '' : 's'} not in the library
            </b>{' '}
            {'–'} counted as zero: <span className="mono">{unknown.slice(0, 8).map((x) => x.l.code).join(', ')}</span>
          </div>
        )}
        {noPrice.length > 0 && (
          <div className="note r" style={s('margin:0 0 10px')}>
            <b>
              {noPrice.length} ingredient{noPrice.length === 1 ? '' : 's'} with no purchase price
            </b>{' '}
            {'–'} counted as zero, so this cost is understated:{' '}
            <span className="mono">{noPrice.slice(0, 8).map((x) => x.l.code).join(', ')}</span>
          </div>
        )}
        {needConv.length > 0 && (
          <div className="note r" style={s('margin:0 0 10px')}>
            <b>
              {needConv.length} line{needConv.length === 1 ? '' : 's'} need a unit conversion
            </b>{' '}
            {'–'} add one on the Unit Conversions screen or they cost nothing:{' '}
            <span className="mono">{needConv.slice(0, 8).map((x) => x.l.code).join(', ')}</span>
          </div>
        )}
        <div className="tw" style={s('max-height:230px;overflow:auto;margin-bottom:14px')}>
          <table>
            <thead>
              <tr>
                <th style={s('width:104px')}>Code</th>
                <th>Ingredient</th>
                <th className="n" style={s('width:74px')}>
                  Qty
                </th>
                <th className="c" style={s('width:52px')}>
                  Unit
                </th>
                <th className="n" style={s('width:62px')}>
                  Yield
                </th>
                <th className="n" style={s('width:96px')}>
                  List price
                </th>
                <th className="n" style={s('width:84px')}>
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ l, v }, i) => {
                const flag = v.kind === 'none' ? 'not in the library' : v.needConv ? 'needs a conversion' : !v.price ? 'no price in the library' : v.kind === 'sub' ? 'sub-recipe' : '';
                return (
                  <tr key={i}>
                    <td className="mono" style={s('color:var(--org-dk);font-weight:700')}>
                      {l.code}
                    </td>
                    <td>
                      {v.name}
                      {flag && <div style={{ fontSize: 11, color: flag === 'sub-recipe' ? 'var(--mute)' : 'var(--bad)' }}>{flag}</div>}
                    </td>
                    <td className="n">{cur(v.qty, v.qty >= 10 ? 0 : 2)}</td>
                    <td className="c" style={s('color:var(--mute);font-size:12px')}>
                      {l.unit || ''}
                    </td>
                    <td className="n" style={s('color:var(--mute)')}>
                      {v.y === 1 ? '–' : pct(v.y)}
                    </td>
                    <td className="n">{v.price ? cur(v.price, 6) : <span style={s('color:var(--bad)')}>0</span>}</td>
                    <td className="n" style={s('font-weight:600')}>
                      {cur(v.cost, 4)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <table style={s('width:100%;font-size:13px;border-collapse:collapse')}>
          <tbody>
            {line('Batch cost from the raw material list', cur(c.batch), `${rows.length} line${rows.length === 1 ? '' : 's'}`, true)}
            {line('Output', `${c.out} portion${c.out === 1 ? '' : 's'}`, c.bOut ? `batch makes ${cur(c.bOut, 1)} ${c.bUom}` : '')}
            {line('Cost per portion', cur(c.orig), 'batch cost ÷ output', true)}
            {pctRow('Yield', rate, c.food - c.orig)}
            {line('Food cost per portion', cur(c.food), '', true)}
            <tr>
              <td colSpan={2} style={s('padding:8px 0 2px;border-top:1px solid var(--line)')}></td>
            </tr>
            {c.sp ? (
              <>
                {pctRow('Packaging', st.pkg, c.pkg)}
                {pctRow('Delivery', st.del, c.del)}
                {pctRow('Labour', st.lab, c.lab)}
                {pctRow('Operations', st.ops, c.ops)}
                {line('Total cost per portion', cur(c.totalCost), '', true)}
                <tr>
                  <td colSpan={2} style={s('padding:8px 0 2px;border-top:1px solid var(--line)')}></td>
                </tr>
                {line('Selling price', cur(c.sp))}
                {line('Net profit', <span style={{ color: c.net < 0 ? 'var(--bad)' : 'var(--grn-dk)' }}>{cur(c.net)}</span>, '', true)}
                {line('Food cost %', <span className={`pill ${fcClass(c.fcPct, st.target)}`}>{pct(c.fcPct)}</span>, `target ${pct(st.target)}`)}
                {line('Net profit %', pct(c.npPct))}
                {line('Price incl. VAT', cur(c.vatPrice), `${pct(st.vat)} on ${cur(c.sp)}`)}
              </>
            ) : (
              line(
                'Selling price',
                <span style={s('color:var(--mute)')}>not set</span>,
                'set one to see food cost %, profit and the overheads',
              )
            )}
            {line(`Suggested price at ${pct(st.target)}`, cur(c.suggest), 'food cost ÷ target food cost %')}
            {isSub && line('Unit cost', `${cur(c.unitCost, 6)} / ${d.recipe.subUom || c.bUom || 'Gram'}`, 'what one unit costs wherever this sub-recipe is used', true)}
          </tbody>
        </table>
        {pkgLines.length > 0 && (
          <div className="note" style={s('margin:12px 0 0')}>
            {pkgLines.length} packaging line{pkgLines.length === 1 ? ' is' : 's are'} inside the ingredients, and Packaging is also
            charged at {pct(st.pkg)} of the selling price above. Counting it in both places doubles it.
          </div>
        )}
      </>
    ),
    foot: (
      <>
        <button className="btn o" onClick={modal.close}>
          Close
        </button>
        <button
          className="btn o"
          onClick={() => {
            modal.close();
            goItems();
          }}
        >
          Open the raw material list
        </button>
      </>
    ),
  });
}

