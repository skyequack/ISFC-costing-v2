'use client';

import { useRouter } from '@/components/shell/nav-progress';
import { Acts } from '@/components/shell/Shell';
import { downloadFile } from '@/components/io/download';
import { api, errText } from '@/components/shared/api-client';
import { CommitInput } from '@/components/shared/inputs';
import { useModal } from '@/components/shared/Modal';
import { Perm } from '@/components/shared/Perm';
import { printDocument } from '@/components/shared/print-doc';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { cur } from '@/lib/format';
import { prodDoc, type SheetData } from '@/lib/print/prod';
import type { ProdData, ProdParams, ReqRow } from '@/lib/screens/prod';

const pad2 = (n: number) => String(n).padStart(2, '0');

function href(p: ProdParams): string {
  const q = new URLSearchParams({ v: p.view, m: p.month, d: p.day, b: p.brand, l: p.loc, c: p.client });
  return `/prod?${q.toString()}`;
}

/** Legacy vProd (2439) with its three views: Daily, Store requisition (vReq 2123) and Monthly. */
export function ProdScreen({ data }: { data: ProdData }) {
  const router = useRouter();
  const toast = useToast();
  const modal = useModal();
  const p = data.params;
  const cu = data.currency;
  const go = (patch: Partial<ProdParams>) => router.replace(href({ ...p, ...patch }));
  const site = p.loc === '*' ? '' : p.loc; // a number typed under "all sites" is saved unassigned (D-20)
  const clientId = p.client === '*' || p.client === 'none' ? '' : p.client; // D-71: '' = unassigned

  async function setProd(code: string, v: string) {
    try {
      await api('PUT', '/api/production', {
        month: p.month,
        day: p.day,
        location: site,
        clientId,
        recipeCode: code,
        portions: parseFloat(v) || 0,
      });
      router.refresh();
    } catch (e) {
      toast(errText(e));
    }
  }

  const sheetData = (): SheetData => ({
    brand: data.brandName,
    site: data.locs.length ? (p.loc === '*' ? 'All sites' : p.loc) : '',
    month: p.month,
    day: p.day,
    weekday: data.weekday,
    sections: data.req.sections.map((sec) => ({
      key: sec.key,
      en: sec.en,
      ar: sec.ar,
      recipes: sec.recipes.map((r) => ({ code: r.code, name: r.name, portions: r.portions, rows: r.rows })),
    })),
    store: data.req.rows,
  });
  function printSheet(kind: string) {
    const html = prodDoc(kind, sheetData());
    if (!html) return toast('Nothing to print – no quantities entered for this day');
    printDocument(html, `production-${p.month}-${p.day}-${kind}.html`, toast);
  }
  function printMenu() {
    const secs = data.req.sections;
    const anyStore = data.req.rows.length > 0;
    if (!secs.length && !anyStore) return toast('No quantities entered for this day yet');
    modal.open({
      title: 'Print production sheets',
      body: (
        <>
          <p style={s('font-size:13px;margin-bottom:12px')}>
            Each sheet prints on its own, so it can be handed to the section that needs it or emailed as a PDF.
          </p>
          <div style={s('display:flex;flex-direction:column;gap:9px')}>
            {secs.map((x) => (
              <button
                key={x.key}
                className="btn o"
                style={s('justify-content:center')}
                onClick={() => (modal.close(), printSheet(x.key))}
              >
                {x.en} {'·'} {x.ar}
              </button>
            ))}
            {anyStore && (
              <button
                className="btn o"
                style={s('justify-content:center')}
                onClick={() => (modal.close(), printSheet('store'))}
              >
                Store requisition
              </button>
            )}
            <button
              className="btn"
              style={s('justify-content:center')}
              onClick={() => (modal.close(), printSheet('all'))}
            >
              Everything, one sheet per page
            </button>
          </div>
          <div className="note" style={s('margin-top:14px')}>
            Each sheet carries the brand, site, date and weekday, a tick column, and a signature line.
          </div>
        </>
      ),
      foot: (
        <button className="btn o" onClick={modal.close}>
          Cancel
        </button>
      ),
    });
  }
  async function exportCsv() {
    const q = new URLSearchParams({ month: p.month, day: p.day, brand: p.brand, loc: p.loc, client: p.client });
    try {
      await downloadFile(`/api/export/${p.view === 'req' ? 'requisition' : 'production'}?${q.toString()}`);
      toast(p.view === 'req' ? 'Requisition exported' : 'Production exported');
    } catch (e) {
      toast(errText(e));
    }
  }

  const head = (
    <div style={s('display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px')}>
      <label className="fl" style={s('margin:0')}>
        Month
      </label>
      <input
        type="month"
        value={p.month}
        onChange={(e) => {
          if (!/^\d{4}-\d{2}$/.test(e.target.value)) return;
          const today = new Date().getDate();
          const nd = new Date(Number(e.target.value.slice(0, 4)), Number(e.target.value.slice(5)), 0).getDate();
          go({ month: e.target.value, day: pad2(Math.min(today, nd)) });
        }}
      />
      {p.view === 'day' && (
        <>
          <label className="fl" style={s('margin:0')}>
            Day
          </label>
          <button
            type="button"
            className="btn sm o daystep"
            aria-label="Previous day"
            disabled={Number(p.day) <= 1}
            onClick={() => go({ day: pad2(Number(p.day) - 1) })}
          >
            {'‹'}
          </button>
          <select value={p.day} onChange={(e) => go({ day: e.target.value })}>
            {Array.from({ length: data.nd }, (_, i) => pad2(i + 1)).map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn sm o daystep"
            aria-label="Next day"
            disabled={Number(p.day) >= data.nd}
            onClick={() => go({ day: pad2(Number(p.day) + 1) })}
          >
            {'›'}
          </button>
          <DayLabel month={p.month} day={p.day} />
        </>
      )}
      <label className="fl" style={s('margin:0')}>
        Brand
      </label>
      <select
        value={p.brand}
        onChange={(e) => go({ brand: e.target.value, loc: '*', client: '*' })}
        style={s('max-width:230px')}
      >
        <option value="*">All brands</option>
        {data.brandOptions.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      {data.clientChoices.length > 0 && (
        <>
          <label className="fl" style={s('margin:0')}>
            Client
          </label>
          <select value={p.client} onChange={(e) => go({ client: e.target.value })} style={s('max-width:200px')}>
            <option value="*">All clients</option>
            <option value="none">Unassigned</option>
            {data.clientChoices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.active ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
        </>
      )}
      {data.locs.length > 0 && (
        <>
          <label className="fl" style={s('margin:0')}>
            Site
          </label>
          <select value={p.loc} onChange={(e) => go({ loc: e.target.value })} style={s('max-width:160px')}>
            <option value="*">All sites</option>
            {data.locs.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </>
      )}
      <span style={s('font-size:12px;color:var(--mute)')}>{data.nCards} cards</span>
    </div>
  );

  return (
    <>
      <Acts>
        <button className={`btn ${p.view === 'day' ? '' : 'o'}`} onClick={() => go({ view: 'day' })}>
          Daily
        </button>
        <button className={`btn ${p.view === 'req' ? '' : 'o'}`} onClick={() => go({ view: 'req' })}>
          Store requisition
        </button>
        <button className={`btn ${p.view === 'month' ? '' : 'o'}`} onClick={() => go({ view: 'month' })}>
          Monthly
        </button>
        <button className="btn o" onClick={printMenu}>
          Print sheets
        </button>
        <button className="btn o" onClick={exportCsv}>
          Export
        </button>
      </Acts>
      {head}
      {p.view === 'month' && <MonthView data={data} cu={cu} />}
      {p.view === 'req' && <ReqView data={data} cu={cu} />}
      {p.view === 'day' && <DayView data={data} cu={cu} setProd={setProd} />}
    </>
  );
}

function MonthView({ data, cu }: { data: ProdData; cu: string }) {
  const m = data.params.month;
  const nd = data.nd;
  const gm = data.monthTotals.total;
  return (
    <>
      <div className="row r3" style={s('margin-bottom:14px')}>
        <div className="kpi">
          <div className="k">Month cost</div>
          <div className="v">{cur(gm, 2)}</div>
          <div className="s">
            {cu} {'·'} {m}
          </div>
        </div>
        <div className="kpi">
          <div className="k">Portions produced</div>
          <div className="v">{data.monthTotals.portions}</div>
          <div className="s">all sections</div>
        </div>
        <div className="kpi">
          <div className="k">Average per day</div>
          <div className="v">{cur(gm / nd, 2)}</div>
          <div className="s">across {nd} days</div>
        </div>
      </div>
      <div className="card">
        <h3>
          {m} {'—'} daily production cost
        </h3>
        <div className="bd">
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="r">Portions</th>
                  {data.secLabels.map((x) => (
                    <th key={x.key} className="r">
                      {x.en}
                    </th>
                  ))}
                  <th className="r">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.monthRows.length ? (
                  data.monthRows.map((r) => (
                    <tr key={r.day}>
                      <td>
                        <b>{r.day}</b>
                      </td>
                      <td className="r">{r.portions}</td>
                      {data.secLabels.map((x) => (
                        <td key={x.key} className="r">
                          {r.sec[x.key] ? cur(r.sec[x.key], 2) : '-'}
                        </td>
                      ))}
                      <td className="r">
                        <b>{cur(r.total, 2)}</b>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={data.secLabels.length + 3} style={s('color:var(--mute)')}>
                      Nothing entered for this month yet.
                    </td>
                  </tr>
                )}
                <tr className="daytot">
                  <td>
                    <b>MONTH</b>
                  </td>
                  <td className="r">
                    <b>{data.monthTotals.portions}</b>
                  </td>
                  {data.secLabels.map((x) => (
                    <td key={x.key} className="r">
                      <b>{cur(data.monthTotals.sec[x.key] || 0, 2)}</b>
                    </td>
                  ))}
                  <td className="r">
                    <b>{cur(gm, 2)}</b>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function DrawRows({ rows }: { rows: ReqRow[] }) {
  return (
    <>
      {rows.map((e) => (
        <tr key={e.code}>
          <td>
            <b>{e.name}</b>
            <div style={s('font-size:11px;color:var(--mute)')}>
              {e.code}
              {Object.keys(e.from).length > 1 ? ` · ${Object.keys(e.from).length} recipes` : ''}
            </div>
          </td>
          <td className="c" style={s('width:70px')}>
            {e.uom}
          </td>
          <td className="r" style={s('width:130px')}>
            <b style={s('font-size:15px;color:var(--org-dk)')}>{cur(e.qty, 1)}</b>
          </td>
          <td className="r" style={s('width:110px')}>
            {cur(e.cost, 2)}
          </td>
        </tr>
      ))}
    </>
  );
}

/** Full weekday + date next to the day picker, tinted when the chosen day is not today (wrong-day guard). */
function DayLabel({ month, day }: { month: string; day: string }) {
  const d = new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, Number(day));
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  return (
    <span className={isToday ? 'daylbl' : 'daylbl off'}>
      {d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
    </span>
  );
}

function DayView({ data, cu, setProd }: { data: ProdData; cu: string; setProd: (code: string, v: string) => void }) {
  const p = data.params;
  const t = data.totals;
  const b = data.builder;
  return (
    <>
      {data.locs.length > 0 && p.loc === '*' && (
        <div className="rolebar">
          Every site is added together here. A number typed now is saved <b>without a site</b> and still counts in the
          totals {'–'} pick a site above if it belongs to one.
        </div>
      )}
      {data.clientChoices.length > 0 && p.client === '*' && (
        <div className="rolebar">
          Every client is added together here. Pick a client, or Unassigned, above to enter numbers.
        </div>
      )}
      <div className="note">
        Enter how many portions each section must cook. Entries are saved per day and kept for the whole month. Cost is
        read from the recipe card, so correcting a purchase price also corrects what past days cost.
      </div>
      <div className="row r3" style={s('margin-bottom:14px')}>
        <div className="kpi">
          <div className="k">
            Day cost {'·'} {p.month}-{p.day}
          </div>
          <div className="v">{cur(t.total, 2)}</div>
          <div className="s">{cu}</div>
        </div>
        <div className="kpi">
          <div className="k">Portions</div>
          <div className="v">{t.portions}</div>
          <div className="s">all sections</div>
        </div>
        <div className="kpi">
          <div className="k">Sections cooking</div>
          <div className="v">{t.secCount}</div>
          <div className="s">of {data.secLabels.length}</div>
        </div>
      </div>
      {b && <MenuBuilder data={data} b={b} cu={cu} />}
      {data.sections.map((sec) => (
        <div className="card" style={s('margin-bottom:14px')} key={sec.key}>
          <h3>
            {sec.en} {'·'} {sec.ar}
            <span style={s('float:right')}>
              {cur(sec.total, 2)} {cu}
            </span>
          </h3>
          <div className="bd">
            <div className="tw pg">
              <table>
                <thead>
                  <tr>
                    <th>Dish</th>
                    <th className="r" style={s('width:110px')}>
                      Cost / portion
                    </th>
                    <th className="c" style={s('width:120px')}>
                      Portions to cook
                    </th>
                    <th className="r" style={s('width:120px')}>
                      Cost
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sec.cards.map((r) => (
                    <tr key={r.code} className={r.qty ? 'filled' : undefined}>
                      <td>
                        {r.name}
                        <div style={s('font-size:11px;color:var(--mute)')}>
                          {r.code}
                          {p.brand === '*' ? ` · ${r.brandCode}` : ''}
                        </div>
                      </td>
                      <td className="r">{cur(r.food, 4)}</td>
                      <td className="c">
                        {r.locked ? (
                          <span title="Pick a client above to enter numbers">{r.qty || '-'}</span>
                        ) : (
                          <Perm perm="recipe.edit">
                            <CommitInput
                              className="cell"
                              type="number"
                              min="0"
                              step="1"
                              value={r.qty || ''}
                              placeholder="0"
                              style={s('width:90px;text-align:right')}
                              onCommit={(v) => setProd(r.code, v)}
                            />
                          </Perm>
                        )}
                      </td>
                      <td className="r">{r.qty ? <b>{cur(r.value, 2)}</b> : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ))}
      {data.draw.rows.length > 0 && (
        <div className="card" style={s('margin-bottom:14px')}>
          <h3>
            Total raw material to cook this day
            <span style={s('float:right')}>
              {data.draw.rows.length} items {'·'} {cur(data.draw.value, 2)} {cu}
            </span>
          </h3>
          <div className="bd">
            <div style={s('font-size:12px;color:var(--mute);margin-bottom:8px')}>
              Every recipe on the day added together, one line per raw material. Use <b>Print sheets</b> to hand this to
              the store.
            </div>
            <div className="tw">
              <table>
                <thead>
                  <tr>
                    <th>Raw material</th>
                    <th className="c">UOM</th>
                    <th className="r">Total to draw</th>
                    <th className="r">Value</th>
                  </tr>
                </thead>
                <tbody>
                  <DrawRows rows={data.draw.rows} />
                  <tr className="daytot">
                    <td>
                      <b>TOTAL</b>
                    </td>
                    <td></td>
                    <td></td>
                    <td className="r">
                      <b>{cur(data.draw.value, 2)}</b>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function MenuBuilder({ data, b, cu }: { data: ProdData; b: NonNullable<ProdData['builder']>; cu: string }) {
  const router = useRouter();
  const toast = useToast();
  const p = data.params;

  async function setPax(menuId: string, v: string) {
    try {
      await api('PUT', '/api/menu-pax', {
        month: p.month,
        day: p.day,
        location: b.site,
        menuId,
        people: parseFloat(v) || 0,
      });
      router.refresh();
    } catch (e) {
      toast(errText(e));
    }
  }
  async function apply() {
    try {
      const r = await api<{ dishes: number; people: number }>('POST', '/api/production/apply-menu-day', {
        month: p.month,
        day: p.day,
        location: p.loc === '*' ? '*' : b.site,
      });
      toast(`${r.dishes} dishes set from ${r.people} people`);
      router.refresh();
    } catch (e) {
      toast(errText(e));
    }
  }

  return (
    <div className="card" style={s('margin-bottom:14px')}>
      <h3>
        Clients per menu {'—'} {b.weekday}
        {b.site ? ` · ${b.site}` : ''}
      </h3>
      <div className="bd">
        <div style={s('font-size:12.5px;color:var(--mute);margin-bottom:10px')}>
          Enter how many people are on each menu. The system reads that weekday from every menu and turns it into the
          dishes to cook {'–'} a dish on several menus has the counts added together.
        </div>
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>Menu</th>
                <th className="c" style={s('width:130px')}>
                  Clients
                </th>
              </tr>
            </thead>
            <tbody>
              {b.menus.map((m) => (
                <tr key={m.id}>
                  <td>
                    <b>{m.name}</b>
                    <div style={s('font-size:11px;color:var(--mute)')}>
                      {m.dishes} dishes on {b.weekday}
                    </div>
                  </td>
                  <td className="c">
                    <Perm perm="recipe.edit">
                      <CommitInput
                        className="cell"
                        type="number"
                        min="0"
                        step="1"
                        value={m.own || ''}
                        placeholder="0"
                        style={s('width:100px;text-align:right')}
                        onCommit={(v) => setPax(m.id, v)}
                      />
                    </Perm>
                    {m.total !== m.own && <div style={s('font-size:10.5px;color:var(--mute)')}>total {m.total}</div>}
                  </td>
                </tr>
              ))}
              <tr className="daytot">
                <td>
                  <b>TOTAL PEOPLE</b>
                </td>
                <td className="c">
                  <b>{b.people}</b>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div style={s('margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap')}>
          <Perm perm="recipe.edit">
            <button className="btn" onClick={apply}>
              Turn into production for {p.day}
            </button>
          </Perm>
          <span style={s('font-size:12.5px')}>
            <b>{b.dishes.length}</b> dishes {'·'} estimated <b>{cur(b.estimate, 2)}</b> {cu}
          </span>
        </div>
        {b.dishes.length > 0 && (
          <div className="tw" style={s('margin-top:12px')}>
            <table>
              <thead>
                <tr>
                  <th>Dish</th>
                  <th className="r" style={s('width:100px')}>
                    Portions
                  </th>
                  <th style={s('width:280px')}>From which menus</th>
                </tr>
              </thead>
              <tbody>
                {b.dishes.map((x) => (
                  <tr key={x.name}>
                    <td>{x.name}</td>
                    <td className="r">
                      <b>{x.q}</b>
                    </td>
                    <td style={s('font-size:11.5px;color:var(--mute)')}>
                      {Object.entries(x.from)
                        .map((f) => `${f[0]} ${f[1]}`)
                        .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {b.missing.length > 0 && (
          <div className="rolebar" style={s('margin-top:10px')}>
            No recipe card behind <b>{b.missing.length}</b> item{b.missing.length === 1 ? '' : 's'} on these menus, so
            they cannot be cooked to a number: {b.missing.slice(0, 8).join(', ')}
            {b.missing.length > 8 ? '…' : ''}
          </div>
        )}
        {b.hasSites && !b.site && (
          <div className="rolebar" style={s('margin-top:10px')}>
            No site picked, so these counts are saved without one. They still appear in the totals and the store
            requisition.
          </div>
        )}
      </div>
    </div>
  );
}

const flagText = (f: ProdData['req']['flags'][number]): string => {
  switch (f.kind) {
    case 'unconvertible':
      return `${f.recipe}: ${f.code} is bought per ${f.itemUom} but written in ${f.lineUnit} with no conversion – not valued`;
    case 'truncated':
      return `${f.recipe}: sub-recipes nested more than 4 levels deep – the rest is not expanded`;
    case 'unknown-code':
      return `${f.recipe}: code ${f.code} is not in the library`;
    case 'no-price':
      return `${f.recipe}: ${f.code} has no purchase price – valued at zero`;
    case 'sub-scale':
      return `${f.recipe}: sub-recipe ${f.sub} scaled from ${cur(f.legacyPortions, 2)} to ${cur(f.appliedPortions, 2)} portions`;
  }
};

/** Legacy vReq (2123) + D-10/D-28: flags and the requisition-vs-card reconciliation. */
function ReqView({ data, cu }: { data: ProdData; cu: string }) {
  const r = data.req;
  const day = data.params.day;
  const real = r.flags.filter((f) => f.kind !== 'sub-scale');
  const bad = r.reconciliation.filter((x) => !x.matches && x.nFlags > 0);
  return (
    <>
      <div className="note">
        This is the draw list for <b>{day}</b>. Quantities are scaled from each card and divided by its yield. A card
        built from another card is expanded, so the store only ever sees raw material.
      </div>
      {real.length > 0 && (
        <div className="note r">
          <b>
            {real.length} thing{real.length === 1 ? '' : 's'} need a look before this list is complete:
          </b>
          <ul style={s('margin:6px 0 0 18px;font-size:12px')}>
            {real.slice(0, 8).map((f, i) => (
              <li key={i}>{flagText(f)}</li>
            ))}
          </ul>
          {real.length > 8 && <div style={s('font-size:12px;margin-top:4px')}>and {real.length - 8} more.</div>}
        </div>
      )}
      <div className="row r3" style={s('margin-bottom:14px')}>
        <div className="kpi">
          <div className="k">Materials to draw</div>
          <div className="v">{r.rows.length}</div>
          <div className="s">distinct items</div>
        </div>
        <div className="kpi">
          <div className="k">Value</div>
          <div className="v">{cur(r.total, 2)}</div>
          <div className="s">
            {cu} {'·'} issue value, excl. waste buffer
          </div>
        </div>
        <div className="kpi">
          <div className="k">Dishes cooking</div>
          <div className="v">{r.dishes}</div>
          <div className="s">across {r.nSections} sections</div>
        </div>
      </div>
      <div className="card" style={s('margin-bottom:16px')}>
        <h3>Store requisition {'·'} consolidated</h3>
        <div className="bd">
          <div style={s('font-size:12px;color:var(--mute);margin-bottom:8px')}>
            One line per raw material, added up across every recipe that uses it.
          </div>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Raw material</th>
                  <th className="c" style={s('width:80px')}>
                    UOM
                  </th>
                  <th className="r" style={s('width:130px')}>
                    Total to issue
                  </th>
                  <th className="r" style={s('width:110px')}>
                    Value
                  </th>
                  <th style={s('width:230px')}>Used by</th>
                </tr>
              </thead>
              <tbody>
                {r.rows.length ? (
                  r.rows.map((e) => (
                    <tr key={e.code}>
                      <td>
                        <b>{e.name}</b>
                        <div style={s('font-size:11px;color:var(--mute)')}>{e.code}</div>
                      </td>
                      <td className="c">{e.uom}</td>
                      <td className="r">
                        <b>{cur(e.qty, 1)}</b>
                      </td>
                      <td className="r">{cur(e.cost, 2)}</td>
                      <td style={s('font-size:11.5px;color:var(--mute)')}>
                        {Object.keys(e.from).length > 1
                          ? Object.entries(e.from)
                              .map((f) => `${f[0]} ${cur(f[1], 0)}`)
                              .join(' · ')
                          : Object.keys(e.from)[0] || ''}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} style={s('color:var(--mute)')}>
                      No quantities entered for this day.
                    </td>
                  </tr>
                )}
                <tr className="daytot">
                  <td>
                    <b>TOTAL</b>
                  </td>
                  <td></td>
                  <td></td>
                  <td className="r">
                    <b>
                      {cur(r.total, 2)} {cu}
                    </b>
                  </td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {r.sections.map((sec) => (
        <div className="card" style={s('margin-bottom:14px')} key={sec.key}>
          <h3>
            {sec.en} {'·'} {sec.ar}
          </h3>
          <div className="bd">
            {sec.recipes.map((x) => (
              <div style={s('margin-bottom:12px')} key={x.code}>
                <div style={s('font-size:13px;font-weight:700;color:var(--org-dk)')}>
                  {x.name} {'·'} {x.portions} portions{' '}
                  <span style={s('font-weight:400;color:var(--mute)')}>
                    ({x.code}
                    {data.params.brand === '*' ? ` · ${x.brandCode}` : ''})
                  </span>
                </div>
                <div className="tw">
                  <table>
                    <thead>
                      <tr>
                        <th>Raw material</th>
                        <th className="c" style={s('width:80px')}>
                          UOM
                        </th>
                        <th className="r" style={s('width:120px')}>
                          Draw
                        </th>
                        <th className="r" style={s('width:110px')}>
                          Cost
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {x.rows.map((e) => (
                        <tr key={e.code}>
                          <td>
                            {e.name}
                            <div style={s('font-size:11px;color:var(--mute)')}>{e.code}</div>
                          </td>
                          <td className="c">{e.uom}</td>
                          <td className="r">
                            <b>{cur(e.qty, 1)}</b>
                          </td>
                          <td className="r">{cur(e.cost, 2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {r.reconciliation.length > 0 && (
        <div className="card" style={s('margin-top:14px')}>
          <h3>Reconciliation {'·'} requisition value against card cost</h3>
          <div className="bd">
            <div style={s('font-size:12px;color:var(--mute);margin-bottom:8px')}>
              For each dish: what the store would issue for its portions, against the card&apos;s cost before the waste
              buffer. A difference is explained by a flag above (missing price, unit conversion, nested sub-recipes).{' '}
              {bad.length ? <b>{bad.length} dish(es) differ.</b> : 'Every dish reconciles.'}
            </div>
            <div className="tw">
              <table>
                <thead>
                  <tr>
                    <th>Dish</th>
                    <th className="r">Portions</th>
                    <th className="r">Requisition value</th>
                    <th className="r">Card cost (before buffer)</th>
                    <th className="r">Difference</th>
                    <th className="c">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {r.reconciliation.map((x) => (
                    <tr key={x.code}>
                      <td>
                        {x.name}
                        <div style={s('font-size:11px;color:var(--mute)')}>{x.code}</div>
                      </td>
                      <td className="r">{x.portions}</td>
                      <td className="r">{cur(x.requisitionValue, 2)}</td>
                      <td className="r">{cur(x.cardValueExBuffer, 2)}</td>
                      <td className="r">{cur(x.variance, 2)}</td>
                      <td className="c">
                        {x.matches ? (
                          <span className="pill p-ok">matches</span>
                        ) : (
                          <span className="pill p-warn">differs</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
