'use client';

import { useRouter } from 'next/navigation';
import { Acts } from '@/components/shell/Shell';
import { api, errText } from '@/components/shared/api-client';
import { createStore, useStore, type Store } from '@/components/shared/form-store';
import { useModal } from '@/components/shared/Modal';
import { Perm } from '@/components/shared/Perm';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { cur } from '@/lib/format';

const CONV_UNITS = ['Gram', 'Ml', 'Each', 'Slice'];
const fine = (u: string) => u === 'Gram' || u === 'Ml';

export interface ConvItem {
  id: string;
  code: string;
  name: string;
  uom: string;
  price: number | null;
  conv: { recipeUnit: string; factor: number } | null;
}

interface Info {
  status: 'ok' | 'bad';
  why: string;
  unitCost: number | null;
  ru: string;
  f: number;
  pu: string;
}

/** Legacy convInfo (3872). */
function info(it: ConvItem): Info {
  const ru = it.conv?.recipeUnit ?? '';
  const f = it.conv?.factor ?? 0;
  const pu = it.uom;
  let status: Info['status'] = 'ok';
  let why = '';
  if (!ru || !f || f <= 0) {
    status = 'bad';
    why = 'No usable factor recorded';
  } else if (ru.toLowerCase().trim() === pu.toLowerCase().trim()) {
    status = 'bad';
    why = 'Recipe unit is the same as the purchase unit – no bridge needed';
  }
  return { status, why, unitCost: it.price != null && f > 0 ? it.price / f : null, ru, f, pu };
}

interface ConvForm {
  code: string;
  unit: string;
  dir: 'p2r' | 'r2p';
  entered: string;
}

/** Legacy vConv (3887) + editConv with the live preview (3924-4030). */
export function ConvScreen({ items, used }: { items: ConvItem[]; used: Record<string, number> }) {
  const router = useRouter();
  const toast = useToast();
  const modal = useModal();
  const withConv = items.filter((i) => i.conv).sort((a, b) => a.code.localeCompare(b.code));
  const broken = withConv.filter((i) => info(i).status !== 'ok').length;

  function edit(code: string | null) {
    const cur0 = code ? items.find((i) => i.code === code) : null;
    const st = createStore<ConvForm>({
      code: code ?? '',
      unit: cur0?.conv?.recipeUnit ?? 'Gram',
      dir: 'p2r',
      entered: cur0?.conv ? String(cur0.conv.factor) : '',
    });
    async function save() {
      const f = st.get();
      const it = items.find((i) => i.code === f.code.trim());
      const entered = parseFloat(f.entered);
      if (!f.code.trim()) return toast('An item code is required');
      if (!it) return toast(`No ingredient carries the code ${f.code} – add the item first`);
      if (!(entered > 0)) return toast('Enter how many units, as a number above zero');
      const factor = f.dir === 'p2r' ? entered : 1 / entered;
      if (!isFinite(factor) || factor <= 0) return toast('That number does not give a usable factor');
      if (f.unit.toLowerCase().trim() === it.uom.toLowerCase().trim()) return toast(`${f.unit} is already how this item is priced – no conversion needed`);
      try {
        await api('PUT', `/api/conversions/${it.id}`, { recipeUnit: f.unit, factor });
        modal.close();
        toast(`Conversion saved – 1 ${it.uom} = ${cur(factor, factor < 1 ? 6 : 2)} ${f.unit}`);
        router.refresh();
      } catch (e) {
        toast(errText(e));
      }
    }
    modal.open({
      title: code ? 'Edit conversion' : 'Add conversion',
      body: <ConvBody st={st} items={items} locked={!!code} />,
      foot: (
        <>
          <button className="btn o" onClick={modal.close}>
            Cancel
          </button>
          <button className="btn" onClick={save}>
            Save
          </button>
        </>
      ),
    });
  }

  function remove(it: ConvItem) {
    const n = used[it.code] ?? 0;
    modal.open({
      title: 'Remove this conversion?',
      body: (
        <>
          <p style={s('font-size:13.5px')}>
            <b>{it.name}</b> ({it.code})
          </p>
          {n ? (
            <div className="note r" style={s('margin-top:12px')}>
              {n} recipe card{n === 1 ? '' : 's'} reference{n === 1 ? 's' : ''} this item. Any line written in a unit other than {it.uom} will
              show <b>needs conversion</b> and cost nothing until a bridge exists again.
            </div>
          ) : (
            <div className="note" style={s('margin-top:12px')}>
              No recipe card currently uses this item.
            </div>
          )}
        </>
      ),
      foot: (
        <>
          <button className="btn o" onClick={modal.close}>
            Cancel
          </button>
          <button
            className="btn d"
            onClick={async () => {
              try {
                await api('DELETE', `/api/conversions/${it.id}`);
                modal.close();
                toast('Conversion removed');
                router.refresh();
              } catch (e) {
                toast(errText(e));
              }
            }}
          >
            Remove
          </button>
        </>
      ),
    });
  }

  return (
    <>
      <Acts>
        <Perm perm="conv.edit">
          <button className="btn" onClick={() => edit(null)}>
            + Add Conversion
          </button>
        </Perm>
      </Acts>
      <div className="note">
        A card written in grams cannot cost an item priced per Each until the bridge below exists. Anything missing shows as{' '}
        <b>needs conversion</b> on the recipe line {'–'} and so does a bridge recorded for the wrong unit, because a factor meant for
        grams cannot be applied to millilitres.
      </div>
      {broken > 0 && (
        <div className="note r">
          <b>
            {broken} conversion{broken === 1 ? '' : 's'} cannot be used.
          </b>{' '}
          Recipe lines relying on {broken === 1 ? 'it' : 'them'} will show <b>needs conversion</b> until {broken === 1 ? 'it is' : 'they are'} corrected.
        </div>
      )}
      <div className="tw">
        <table>
          <thead>
            <tr>
              <th style={s('width:130px')}>Code</th>
              <th>Item</th>
              <th className="c" style={s('width:96px')}>
                Priced per
              </th>
              <th style={s('width:210px')}>The bridge</th>
              <th className="n" style={s('width:140px')}>
                Cost per recipe unit
              </th>
              <th className="c" style={s('width:110px')}>
                Status
              </th>
              <th style={s('width:120px')}></th>
            </tr>
          </thead>
          <tbody>
            {withConv.map((it) => {
              const i = info(it);
              return (
                <tr key={it.id}>
                  <td className="mono" style={s('color:var(--org-dk);font-weight:700')}>
                    {it.code}
                  </td>
                  <td>{it.name}</td>
                  <td className="c" style={s('color:var(--mute);font-size:12px')}>
                    {i.pu}
                  </td>
                  <td style={s('font-size:12.5px')}>
                    {i.f > 0 && i.ru ? (
                      i.f < 1 ? (
                        <>
                          1 {i.ru} = <b>{cur(1 / i.f, 2)}</b> {i.pu || 'purchase unit'}
                        </>
                      ) : (
                        <>
                          1 {i.pu || 'purchase unit'} = <b>{cur(i.f, 2)}</b> {i.ru}
                        </>
                      )
                    ) : (
                      <span style={s('color:var(--mute)')}>not recorded</span>
                    )}
                  </td>
                  <td className="n">
                    {i.unitCost != null ? (
                      <>
                        {cur(i.unitCost, 6)} <span style={s('color:var(--mute);font-size:11px')}>/ {i.ru}</span>
                      </>
                    ) : (
                      <span style={s('color:var(--mute)')}>-</span>
                    )}
                  </td>
                  <td className="c">
                    {i.status === 'ok' ? (
                      <span className="pill p-ok">OK</span>
                    ) : (
                      <span className="pill p-bad" title={i.why}>
                        check
                      </span>
                    )}
                  </td>
                  <td className="c">
                    <Perm perm="conv.edit">
                      <button className="btn sm o" onClick={() => edit(it.code)}>
                        Edit
                      </button>
                    </Perm>{' '}
                    <Perm perm="conv.edit">
                      <button className="btn sm d" onClick={() => remove(it)}>
                        {'×'}
                      </button>
                    </Perm>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {withConv.length === 0 && (
        <div className="card">
          <div className="empty">
            <div className="big">{'⇄'}</div>
            <p>No conversions yet. Add one for any item you buy by the piece but cook by weight.</p>
          </div>
        </div>
      )}
    </>
  );
}

function ConvBody({ st, items, locked }: { st: Store<ConvForm>; items: ConvItem[]; locked: boolean }) {
  const f = useStore(st);
  const it = items.find((i) => i.code === f.code.trim());
  const pu = it?.uom ?? '';
  const puTxt = pu || 'purchase unit';
  const entered = parseFloat(f.entered);
  const factor = entered > 0 ? (f.dir === 'p2r' ? entered : 1 / entered) : 0;
  const easyIsA = !fine(pu) && fine(f.unit);
  const easyIsB = fine(pu) && !fine(f.unit);
  const tag = '   ← usually the easy one';

  let preview: React.ReactNode;
  if (!f.code.trim() || !entered || entered <= 0) preview = 'Fill in the code and the number to see what this will do to a recipe line.';
  else if (it && f.unit.toLowerCase().trim() === pu.toLowerCase().trim())
    preview = (
      <>
        <b style={s('color:var(--bad)')}>{f.unit} is already how this item is priced.</b> No conversion is needed {'–'} recipe lines in {f.unit} will cost
        correctly without one.
      </>
    );
  else {
    const price = it && it.price != null ? it.price : null;
    const unitCost = price != null ? price / factor : null;
    const sample = fine(f.unit) ? 100 : 1;
    preview = (
      <>
        <div>
          Stored as: 1 {puTxt} = <b>{cur(factor, factor < 1 ? 6 : 2)}</b> {f.unit}
          {f.dir === 'r2p' && <span style={s('color:var(--mute)')}> (the reciprocal of the {cur(entered, 2)} you typed)</span>}
        </div>
        {unitCost != null ? (
          <>
            <div style={s('margin-top:7px')}>
              A line of <b>{sample} {f.unit}</b> will draw {cur(sample / factor, 4)} {puTxt} and cost <b>{cur(unitCost * sample, 4)}</b>{' '}
              <span style={s('color:var(--mute)')}>({cur(unitCost, 6)} per {f.unit})</span>.
            </div>
            {fine(f.unit) && !fine(pu) && factor < 1 && (
              <div style={s('margin-top:7px;color:var(--bad);font-weight:600')}>
                That says one {puTxt} holds less than a single {f.unit}. Check the direction.
              </div>
            )}
            {!fine(f.unit) && fine(pu) && factor > 1 && (
              <div style={s('margin-top:7px;color:var(--bad);font-weight:600')}>
                That says one {puTxt} makes more than one {f.unit}. Check the direction.
              </div>
            )}
          </>
        ) : (
          <div style={s('margin-top:7px;color:var(--mute)')}>This item has no purchase price yet, so the cost cannot be previewed.</div>
        )}
      </>
    );
  }

  return (
    <>
      <div className="field">
        <label className="fl">Item Code</label>
        <input type="text" className="cell mono" value={f.code} readOnly={locked} autoFocus={!locked} onChange={(e) => st.set({ code: e.target.value })} />
      </div>
      <div id="c_item" style={s('font-size:12.5px;margin:-6px 0 14px;min-height:18px')}>
        {f.code.trim() ? (
          it ? (
            <>
              <b>{it.name}</b>{' '}
              <span style={s('color:var(--mute)')}>
                {'·'} priced per {pu} at {it.price == null ? 'no price yet' : cur(it.price, 6)}
              </span>
            </>
          ) : (
            <span style={s('color:var(--bad);font-weight:600')}>No ingredient carries the code {f.code.trim()}</span>
          )
        ) : (
          <span style={s('color:var(--mute)')}>Type an item code to see what it is priced by.</span>
        )}
      </div>
      <div className="field">
        <label className="fl">Recipe cards for this item will be written in</label>
        <select value={f.unit} onChange={(e) => st.set({ unit: e.target.value })}>
          {CONV_UNITS.map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="fl">State the relationship</label>
        <label style={s('display:flex;gap:9px;align-items:flex-start;margin-bottom:7px;cursor:pointer')}>
          <input type="radio" name="c_dir" checked={f.dir === 'p2r'} onChange={() => st.set({ dir: 'p2r' })} style={s('margin-top:3px')} />
          <span style={s('font-size:13px')}>
            1 {puTxt} = ? {f.unit}
            {easyIsA ? tag : ''}
          </span>
        </label>
        <label style={s('display:flex;gap:9px;align-items:flex-start;cursor:pointer')}>
          <input type="radio" name="c_dir" checked={f.dir === 'r2p'} onChange={() => st.set({ dir: 'r2p' })} style={s('margin-top:3px')} />
          <span style={s('font-size:13px')}>
            1 {f.unit} = ? {puTxt}
            {easyIsB ? tag : ''}
          </span>
        </label>
      </div>
      <div className="field">
        <label className="fl">{f.dir === 'p2r' ? `How many ${f.unit} in one ${puTxt}?` : `How many ${puTxt} in one ${f.unit}?`}</label>
        <input type="number" step="any" min="0" className="cell" value={f.entered} autoFocus={locked} onChange={(e) => st.set({ entered: e.target.value })} />
      </div>
      <div className="note" style={s('margin:0')}>
        {preview}
      </div>
    </>
  );
}
