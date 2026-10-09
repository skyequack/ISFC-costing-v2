'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Acts } from '@/components/shell/Shell';
import { api, errText } from '@/components/shared/api-client';
import { createStore, useStore, type Store } from '@/components/shared/form-store';
import { CommitInput } from '@/components/shared/inputs';
import { useModal } from '@/components/shared/Modal';
import { Perm } from '@/components/shared/Perm';
import { usePerm } from '@/components/shared/session-context';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { MENU_DAYS } from '@/data';
import { cur } from '@/lib/format';
import type { PlanCellDto, PlanData, PlanMenuDto } from '@/lib/screens/plan';

/** Legacy vPlan (1923): the menu as written, costs under each item, family tabs and the per-pax-per-day table. */
export function PlanScreen({ data }: { data: PlanData }) {
  const router = useRouter();
  const toast = useToast();
  const modal = useModal();
  const can = usePerm();
  const active = data.menus.filter((m) => m.active);
  const [sel, setSel] = useState(active[0]?.id ?? '');
  const [planPax, setPlanPax] = useState(1);
  const [editing, setEditing] = useState(false);
  const cu = data.currency;

  const m = active.find((x) => x.id === sel) ?? active[0];
  if (!m)
    return (
      <>
        <Acts>
          <Perm perm="menu.edit">
            <button className="btn" onClick={() => addMenu()}>
              + New menu
            </button>
          </Perm>
        </Acts>
        <div className="note">No menus yet.</div>
      </>
    );

  const fams: string[] = [];
  active.forEach((x) => {
    if (!fams.includes(x.family)) fams.push(x.family);
  });
  const fam = m.family;
  const days = m.days;
  const wk = m.week;
  const un = m.unpriced;

  async function setPrice(code: string, val: string) {
    const v = parseFloat(String(val).replace(/,/g, ''));
    if (!isFinite(v) || v < 0) return toast('Enter a price of 0 or more');
    try {
      const r = await api<{ name: string }>('POST', '/api/menu-price', { code, price: v });
      toast(`${r.name} priced at ${cur(v, 4)}`);
      router.refresh();
    } catch (e) {
      toast(errText(e));
    }
  }

  function addMenu() {
    const st = createStore({ name: '', busy: false });
    modal.open({
      title: 'New menu',
      body: <NameBody st={st} />,
      foot: (
        <>
          <button className="btn o" onClick={modal.close}>
            Cancel
          </button>
          <button
            className="btn"
            onClick={async () => {
              const name = st.get().name.trim();
              if (!name) return toast('Type a menu name');
              try {
                await api('POST', '/api/menus', { name, days: [...MENU_DAYS] });
                modal.close();
                toast('Menu created');
                router.refresh();
              } catch (e) {
                toast(errText(e));
              }
            }}
          >
            Create
          </button>
        </>
      ),
    });
  }

  async function deactivate() {
    try {
      await api('POST', `/api/menus/${m!.id}/active`, { active: false });
      toast('Menu deactivated – its headcounts are kept');
      router.refresh();
    } catch (e) {
      toast(errText(e));
    }
  }

  function exportCsv() {
    window.location.href = `/api/export/plan?menuId=${encodeURIComponent(m!.id)}`;
    toast('Menu exported');
  }

  let lastMeal = '';
  return (
    <>
      <Acts>
        <button className="btn o" onClick={exportCsv}>
          Export this menu
        </button>
        <Perm perm="menu.edit">
          <button className="btn o" onClick={() => setEditing((e) => !e)}>
            {editing ? 'Done editing' : 'Edit this menu'}
          </button>
        </Perm>
        <Perm perm="menu.edit">
          <button className="btn o" onClick={addMenu}>
            + New menu
          </button>
        </Perm>
      </Acts>

      {editing && can('menu.edit') ? (
        <MenuEditor m={m} onDone={() => (setEditing(false), router.refresh())} onDeactivate={deactivate} />
      ) : (
        <>
          <div className="note">
            The menu is shown as written, with the cost sitting under each item. A cost comes from the recipe card where
            one exists, otherwise from the menu item&apos;s price in the Ingredient Library. Unpriced items count as
            zero and are shaded, so a day total is <b>a floor, not the real cost</b>, until every item is priced.
          </div>
          <div style={s('display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px')}>
            {fams.map((f) => (
              <button
                key={f}
                className={`btn ${f === fam ? '' : 'o'}`}
                onClick={() => setSel(active.find((x) => x.family === f)!.id)}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="card" style={s('margin-bottom:16px')}>
            <h3>
              {fam} {'—'} cost per pax per day
            </h3>
            <div className="bd">
              <div className="tw">
                <table>
                  <thead>
                    <tr>
                      <th>Menu</th>
                      {MENU_DAYS.map((dy) => (
                        <th key={dy} className="r">
                          {dy.slice(0, 3)}
                        </th>
                      ))}
                      <th className="r">Week</th>
                      <th className="c">Unpriced</th>
                    </tr>
                  </thead>
                  <tbody>
                    {active
                      .filter((x) => x.family === fam)
                      .map((x) => (
                        <tr
                          key={x.id}
                          className={x.id === m.id ? 'on' : ''}
                          style={s('cursor:pointer')}
                          onClick={() => setSel(x.id)}
                        >
                          <td>
                            <b>{x.name}</b>
                          </td>
                          {MENU_DAYS.map((dy) => (
                            <td key={dy} className="r">
                              {!x.days.includes(dy) ? '-' : cur(x.dayTot[dy]?.tot ?? 0, 2)}
                            </td>
                          ))}
                          <td className="r">
                            <b>{cur(x.week, 2)}</b>
                          </td>
                          <td className="c">
                            {x.unpriced ? (
                              <span className="pill p-warn">{x.unpriced}</span>
                            ) : (
                              <span className="pill p-ok">0</span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <div style={s('font-size:11.5px;color:var(--mute);margin-top:8px')}>Pick a row to open it below.</div>
            </div>
          </div>
          <div className="row r3" style={s('margin-bottom:14px')}>
            <div className="kpi">
              <div className="k">
                {m.name} {'·'} week
              </div>
              <div className="v">{cur(wk, 2)}</div>
              <div className="s">{cu} per person</div>
            </div>
            <div className="kpi">
              <div className="k">Average per day</div>
              <div className="v">{cur(wk / Math.max(1, days.length), 2)}</div>
              <div className="s">per person</div>
            </div>
            <div className={`kpi ${un ? 'r' : ''}`}>
              <div className="k">Items with no price</div>
              <div className="v">{un}</div>
              <div className="s">{un ? 'type a price into any shaded cell' : 'fully costed'}</div>
            </div>
          </div>
          <div className="card" style={s('margin-bottom:14px')}>
            <div className="bd" style={s('display:flex;gap:14px;align-items:center;flex-wrap:wrap')}>
              <label className="fl" style={s('margin:0')}>
                Headcount
              </label>
              <input
                type="number"
                min="1"
                step="1"
                value={planPax}
                style={s('width:110px;text-align:right')}
                onChange={(e) => setPlanPax(Math.max(1, Math.round(+e.target.value || 1)))}
              />
              <div style={s('font-size:13px')}>
                <b>
                  {cur(wk * planPax, 2)} {cu}
                </b>{' '}
                per week for {planPax} {'·'}{' '}
                <b>
                  {cur((wk / Math.max(1, days.length)) * planPax, 2)} {cu}
                </b>{' '}
                per day
              </div>
            </div>
          </div>
          <div className="card">
            <h3>{m.name}</h3>
            <div className="bd">
              <div className="tw">
                <table>
                  <thead>
                    <tr>
                      <th style={s('width:110px')}>Meal</th>
                      {days.map((dy) => (
                        <th key={dy} className="c">
                          {dy}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {m.rows.map((r, ri) => {
                      const headRow = r.meal !== lastMeal ? ((lastMeal = r.meal), true) : false;
                      return <PlanRow key={ri} r={r} days={days} head={headRow} onPrice={setPrice} />;
                    })}
                    <tr className="daytot">
                      <td>
                        <b>TOTAL / PAX</b>
                      </td>
                      {days.map((dy) => {
                        const t = m.dayTot[dy]!;
                        return (
                          <td key={dy} className="r">
                            <b>{cur(t.tot, 3)}</b>
                            <div style={s('font-size:10.5px;font-weight:400')}>
                              {planPax > 1 ? (
                                <>
                                  {cur(t.tot * planPax, 2)} for {planPax}
                                  <br />
                                </>
                              ) : null}
                              {t.unp} not priced
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
              <div style={s('margin-top:10px;font-size:13px')}>
                <b>
                  Week total per pax: {cur(wk, 2)} {cu}
                </b>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function PlanRow({
  r,
  days,
  head,
  onPrice,
}: {
  r: PlanMenuDto['rows'][number];
  days: string[];
  head: boolean;
  onPrice: (code: string, v: string) => void;
}) {
  return (
    <>
      {head && (
        <tr className="mealhead">
          <td colSpan={days.length + 1}>
            <b>{r.meal}</b>
          </td>
        </tr>
      )}
      <tr>
        <td style={s('font-size:11.5px;color:var(--mute)')}>{r.meal}</td>
        {days.map((dy) => {
          const c: PlanCellDto | null | undefined = r.cells[dy];
          if (!c) return <td key={dy}></td>;
          const bad = c.v == null || c.v === 0;
          return (
            <td key={dy} className={bad ? 'warnrow' : ''} style={s('vertical-align:top')}>
              <div style={s('font-size:12px')}>{c.label}</div>
              {c.editable ? (
                <Perm perm="items.edit">
                  <CommitInput
                    className="cell"
                    type="number"
                    step="0.0001"
                    min="0"
                    placeholder="price"
                    style={s('width:88px;text-align:right;font-size:12px')}
                    value=""
                    onCommit={(v) => v && onPrice(c.code!, v)}
                  />
                </Perm>
              ) : (
                <div style={{ fontSize: 12, fontWeight: 700, color: bad ? 'var(--mute)' : 'var(--org-dk)' }}>
                  {bad ? c.src : cur(c.v, 3)}
                </div>
              )}
            </td>
          );
        })}
      </tr>
    </>
  );
}

function NameBody({ st }: { st: Store<{ name: string }> }) {
  const f = useStore(st);
  return (
    <div className="field">
      <label className="fl">Menu name</label>
      <input type="text" className="cell" value={f.name} autoFocus onChange={(e) => st.set({ name: e.target.value })} />
    </div>
  );
}

type Draft = {
  name: string;
  days: string[];
  rows: {
    meal: string;
    cells: Record<string, { label: string; kind: 'ITEM' | 'RECIPE' | 'NONE'; code: string } | null>;
  }[];
};

/** Basic menu editor (D-05): rename, choose the days, edit meals and dishes (text, kind, code). Built from legacy primitives. */
function MenuEditor({ m, onDone, onDeactivate }: { m: PlanMenuDto; onDone: () => void; onDeactivate: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<Draft>({
    name: m.name,
    days: m.days,
    rows: m.rows.map((r) => ({
      meal: r.meal,
      cells: Object.fromEntries(
        Object.entries(r.cells).map(([k, c]) => [k, c ? { label: c.label, kind: c.kind, code: c.code ?? '' } : null]),
      ),
    })),
  });
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api('PUT', `/api/menus/${m.id}`, {
        version: m.version,
        name: d.name.trim(),
        days: d.days,
        rows: d.rows.map((r) => ({
          meal: r.meal.trim(),
          cells: Object.fromEntries(
            Object.entries(r.cells).map(([k, c]) => [
              k,
              c && c.label.trim()
                ? {
                    label: c.label.trim(),
                    kind: c.code.trim() ? (c.kind === 'NONE' ? 'ITEM' : c.kind) : 'NONE',
                    code: c.code.trim() || null,
                  }
                : null,
            ]),
          ),
        })),
      });
      toast('Menu saved');
      onDone();
    } catch (e) {
      setBusy(false);
      toast(errText(e));
    }
  }

  return (
    <>
      <div className="note">
        Edit the menu as written: the meal on each row, and for each day the dish text, whether it points at an
        ingredient-library item or a recipe card, and its code. Leave a dish text empty to clear that cell.
      </div>
      <div className="card" style={s('margin-bottom:14px')}>
        <div className="bd" style={s('display:flex;gap:12px;align-items:center;flex-wrap:wrap')}>
          <label className="fl" style={s('margin:0')}>
            Menu name
          </label>
          <input
            type="text"
            style={s('max-width:300px')}
            value={d.name}
            onChange={(e) => setD({ ...d, name: e.target.value })}
          />
          {MENU_DAYS.map((dy) => (
            <label key={dy} style={s('font-size:12px;display:flex;gap:5px;align-items:center;cursor:pointer')}>
              <input
                type="checkbox"
                checked={d.days.includes(dy)}
                onChange={(e) =>
                  setD({ ...d, days: MENU_DAYS.filter((x) => (x === dy ? e.target.checked : d.days.includes(x))) })
                }
              />
              {dy.slice(0, 3)}
            </label>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="bd">
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th style={s('width:130px')}>Meal</th>
                  {d.days.map((dy) => (
                    <th key={dy}>{dy}</th>
                  ))}
                  <th style={s('width:34px')}></th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r, ri) => (
                  <tr key={ri}>
                    <td style={s('vertical-align:top')}>
                      <input
                        type="text"
                        value={r.meal}
                        onChange={(e) =>
                          setD({ ...d, rows: d.rows.map((x, j) => (j === ri ? { ...x, meal: e.target.value } : x)) })
                        }
                      />
                    </td>
                    {d.days.map((dy) => {
                      const c = r.cells[dy] ?? { label: '', kind: 'ITEM' as const, code: '' };
                      const set = (patch: Partial<typeof c>) =>
                        setD({
                          ...d,
                          rows: d.rows.map((x, j) =>
                            j === ri ? { ...x, cells: { ...x.cells, [dy]: { ...c, ...patch } } } : x,
                          ),
                        });
                      return (
                        <td key={dy} style={s('vertical-align:top;min-width:150px')}>
                          <input
                            type="text"
                            placeholder="dish"
                            value={c.label}
                            onChange={(e) => set({ label: e.target.value })}
                            style={s('margin-bottom:4px;font-size:12px')}
                          />
                          <div style={s('display:flex;gap:4px')}>
                            <select
                              value={c.kind === 'NONE' ? 'ITEM' : c.kind}
                              onChange={(e) => set({ kind: e.target.value as 'ITEM' | 'RECIPE' })}
                              style={s('width:78px;font-size:11px')}
                            >
                              <option value="ITEM">item</option>
                              <option value="RECIPE">card</option>
                            </select>
                            <input
                              type="text"
                              placeholder="code"
                              value={c.code}
                              onChange={(e) => set({ code: e.target.value })}
                              style={s('font-size:11px')}
                            />
                          </div>
                        </td>
                      );
                    })}
                    <td className="c" style={s('vertical-align:top')}>
                      <button
                        className="btn sm d"
                        onClick={() => setD({ ...d, rows: d.rows.filter((_, j) => j !== ri) })}
                      >
                        {'×'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={s('margin-top:12px;display:flex;gap:9px')}>
            <button className="btn sm o" onClick={() => setD({ ...d, rows: [...d.rows, { meal: '', cells: {} }] })}>
              Add a row
            </button>
            <button className="btn" disabled={busy} onClick={save}>
              Save menu
            </button>
            <button className="btn d" onClick={onDeactivate}>
              Deactivate menu
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
