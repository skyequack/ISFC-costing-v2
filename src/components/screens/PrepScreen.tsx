'use client';

import { useRouter } from '@/components/shell/nav-progress';
import { Acts } from '@/components/shell/Shell';
import { downloadFile } from '@/components/io/download';
import { api, errText } from '@/components/shared/api-client';
import { CommitInput } from '@/components/shared/inputs';
import { Perm } from '@/components/shared/Perm';
import { downloadText, pageCss } from '@/components/shared/print-doc';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { MENU_DAYS } from '@/data';
import { cur } from '@/lib/format';
import { prepDoc } from '@/lib/print/prod';
import type { PrepData } from '@/lib/screens/plan';

const title = (d: string) => d.charAt(0) + d.slice(1).toLowerCase();

/** Legacy vPrep (1758): site, weekday, headcount per menu -> dishes -> raw materials. Reads the same stored headcounts as Production. */
export function PrepScreen({ data }: { data: PrepData }) {
  const router = useRouter();
  const toast = useToast();
  const p = data.params;
  const R = data.result;
  const go = (patch: Partial<typeof p>) => {
    const n = { ...p, ...patch };
    router.replace(`/prep?${new URLSearchParams({ m: n.month, d: n.day, l: n.loc, wd: n.weekday }).toString()}`);
  };
  const site = p.loc === '*' ? '' : p.loc;

  async function setPax(menuId: string, v: string) {
    try {
      await api('PUT', '/api/menu-pax', {
        month: p.month,
        day: p.day,
        location: site,
        menuId,
        people: parseFloat(v) || 0,
      });
      router.refresh();
    } catch (e) {
      toast(errText(e));
    }
  }

  async function csv() {
    if (!R.rows.length) return toast('Nothing to export yet');
    const q = new URLSearchParams({ month: p.month, day: p.day, loc: p.loc, wd: p.weekday });
    try {
      await downloadFile(`/api/export/prep?${q.toString()}`);
      toast('Requisition exported');
    } catch (e) {
      toast(errText(e));
    }
  }

  async function send() {
    if (!R.rows.length) return toast('Put a headcount against a menu first');
    const label = p.loc === '*' ? 'All sites' : p.loc;
    const doc = prepDoc({
      site: label,
      weekday: p.weekday,
      people: R.people,
      dishes: R.dishes.length,
      menus: R.menus.map((m) => ({ name: m.name, pax: m.pax, dishes: m.dishes })),
      rows: R.rows,
      printedAt: new Date().toLocaleString(),
      css: pageCss(),
    });
    let w: Window | null = null;
    try {
      const url = URL.createObjectURL(new Blob([doc], { type: 'text/html;charset=utf-8' }));
      w = window.open(url, '_blank');
      if (w) {
        setTimeout(() => {
          try {
            w!.focus();
            w!.print();
          } catch {
            /* ignore */
          }
        }, 500);
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch {
      w = null;
    }
    if (!w) {
      downloadText('store-requisition.html', doc, 'text/html;charset=utf-8');
      toast('The browser blocked the new tab – the requisition was downloaded');
    }
    try {
      await api('POST', '/api/production/prep-sent', { site: label, materials: R.rows.length });
    } catch (e) {
      toast(errText(e));
    }
  }

  return (
    <>
      <Acts>
        {R.rows.length > 0 && (
          <>
            <button className="btn o" onClick={csv}>
              {'⤓'} CSV
            </button>
            <Perm perm="export">
              <button className="btn" onClick={send}>
                {'⎙'} Send to the store
              </button>
            </Perm>
          </>
        )}
      </Acts>
      {!data.menusVisible && (
        <div className="note r">
          <b>Menu plans belong to the SSEM project.</b> Ask the General Manager for access to SSEM to use Preparation.
        </div>
      )}
      <div className="card">
        <div className="ch">
          <b>1 &nbsp;Site</b>
          <span>
            {data.locs.length ? 'Which site is this for' : 'No site is set up on this brand – the whole brand is used'}
          </span>
        </div>
        <div style={s('padding:12px 14px;display:flex;gap:9px;flex-wrap:wrap')}>
          {data.locs.length ? (
            <select
              className="cell"
              style={s('max-width:280px')}
              value={p.loc === '*' ? '' : p.loc}
              onChange={(e) => go({ loc: e.target.value || '*' })}
            >
              <option value="">All sites</option>
              {data.locs.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          ) : (
            <span style={s('font-size:12.5px;color:var(--mute)')}>
              Add sites to the brand in Brand Workspaces if you need them split.
            </span>
          )}
          <select
            className="cell"
            style={s('max-width:200px')}
            value={p.weekday}
            onChange={(e) => go({ weekday: e.target.value })}
          >
            {MENU_DAYS.map((d) => (
              <option key={d} value={d}>
                {title(d)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="card" style={s('margin-top:14px')}>
        <div className="ch">
          <b>2 &nbsp;Menu and headcount</b>
          <span>Put the number of people against each menu {'–'} leave the rest blank</span>
        </div>
        <div className="tw" style={s('max-height:300px;overflow:auto')}>
          <table>
            <thead>
              <tr>
                <th>Menu</th>
                <th className="n" style={s('width:120px')}>
                  People
                </th>
                <th className="n" style={s('width:110px')}>
                  Dishes today
                </th>
              </tr>
            </thead>
            <tbody>
              {data.menus.map((m) => (
                <tr key={m.id} style={m.total ? s('background:var(--org-lt)') : undefined}>
                  <td style={m.total ? s('font-weight:600') : undefined}>{m.name}</td>
                  <td className="n">
                    <Perm perm="recipe.edit">
                      <CommitInput
                        className="cell"
                        type="number"
                        min="0"
                        step="1"
                        style={{ textAlign: 'right', fontWeight: m.total ? 700 : undefined }}
                        value={m.own || ''}
                        placeholder="0"
                        onCommit={(v) => setPax(m.id, v)}
                      />
                    </Perm>
                    {m.total !== m.own && <div style={s('font-size:10.5px;color:var(--mute)')}>total {m.total}</div>}
                  </td>
                  <td className="n" style={s('color:var(--mute);font-size:11.5px')}>
                    {m.dishes}
                    {m.missing > 0 && (
                      <>
                        {' '}
                        <span className="pill p-warn">{m.missing} unmatched</span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {R.people ? (
        <>
          <div className="kpis" style={s('margin-top:14px')}>
            <div className="kpi">
              <span>People</span>
              <b>{cur(R.people, 0)}</b>
            </div>
            <div className="kpi">
              <span>Dishes to cook</span>
              <b>{R.dishes.length}</b>
            </div>
            <div className="kpi">
              <span>Raw materials</span>
              <b>{R.rows.length}</b>
            </div>
            <div className="kpi">
              <span>Food cost</span>
              <b>{cur(R.totalCost, 2)}</b>
            </div>
          </div>
          <div className="card" style={s('margin-top:14px')}>
            <div className="ch">
              <b>3 &nbsp;Dishes the menus come to</b>
              <span>
                {title(p.weekday)}
                {p.loc !== '*' ? ` · ${p.loc}` : ''}
              </span>
            </div>
            <div className="tw" style={s('max-height:320px;overflow:auto')}>
              <table>
                <thead>
                  <tr>
                    <th style={s('width:130px')}>Code</th>
                    <th>Dish</th>
                    <th style={s('width:200px')}>From which menu</th>
                    <th className="n" style={s('width:100px')}>
                      Portions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {R.dishes.map((d) => (
                    <tr key={d.code}>
                      <td className="mono" style={s('font-size:11.5px')}>
                        {d.code}
                      </td>
                      <td>{d.name}</td>
                      <td style={s('font-size:11px;color:var(--mute)')}>{d.from.join(', ')}</td>
                      <td className="n" style={s('font-weight:600')}>
                        {cur(d.pax, 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {R.missing.length > 0 && (
              <div className="note r" style={s('margin:12px 14px 14px')}>
                <b>
                  {R.missing.length} menu line{R.missing.length === 1 ? '' : 's'} have no recipe card
                </b>
                , so nothing is drawn for them: {R.missing.slice(0, 6).join(', ')}
                {R.missing.length > 6 ? ' and more' : ''}. They need a card, or a card whose name matches, before the
                store list is complete.
              </div>
            )}
          </div>
          <div className="card" style={s('margin-top:14px')}>
            <div className="ch">
              <b>4 &nbsp;Raw materials to draw</b>
              <span>Every dish added together {'–'} one line per material</span>
            </div>
            <div className="note" style={s('margin:10px 14px 0')}>
              The same material from several dishes is added into one line. <b>Wanted by</b> shows which dishes asked
              for it, so a short delivery can be traced back to what will be short.
            </div>
            <div className="tw">
              <table>
                <thead>
                  <tr>
                    <th style={s('width:130px')}>Code</th>
                    <th>Raw material</th>
                    <th style={s('width:58px')}>Unit</th>
                    <th className="n" style={s('width:130px')}>
                      Quantity
                    </th>
                    <th style={s('width:230px')}>Wanted by</th>
                    <th className="n" style={s('width:110px')}>
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {R.rows.map((x) => (
                    <tr key={x.code}>
                      <td className="mono" style={s('font-size:11.5px')}>
                        {x.code}
                      </td>
                      <td>{x.name}</td>
                      <td style={s('font-size:11.5px;color:var(--mute)')}>{x.uom || ''}</td>
                      <td className="n mono" style={s('font-weight:700')}>
                        {cur(x.qty, 2)}
                      </td>
                      <td style={s('font-size:11px;color:var(--mute)')}>
                        {x.wantedBy.slice(0, 3).join(', ')}
                        {x.wantedBy.length > 3 ? ` +${x.wantedBy.length - 3}` : ''}
                      </td>
                      <td className="n">{cur(x.cost, 2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={s('background:var(--org-lt);font-weight:700')}>
                    <td colSpan={5} style={s('padding:9px 10px')}>
                      TOTAL {'·'} {R.rows.length} materials
                    </td>
                    <td className="n">{cur(R.totalCost, 2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="card" style={s('margin-top:14px;padding:24px;text-align:center')}>
          <p style={s('color:var(--mute);font-size:13px;margin:0')}>
            Put a headcount against a menu above. The dishes and the materials to draw are worked out from the recipe
            cards.
          </p>
        </div>
      )}
    </>
  );
}
