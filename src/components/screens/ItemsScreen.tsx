'use client';

import { useRouter } from '@/components/shell/nav-progress';
import { useMemo, useState } from 'react';
import { useItemIO } from '@/components/io/items-io';
import { Acts } from '@/components/shell/Shell';
import { api, errText } from '@/components/shared/api-client';
import { createStore, useStore, type Store } from '@/components/shared/form-store';
import { useModal } from '@/components/shared/Modal';
import { Perm } from '@/components/shared/Perm';
import { usePerm } from '@/components/shared/session-context';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { cur } from '@/lib/format';
import type { IngredientDto } from '@/lib/db/repo/ingredients';
import { fitUnit, UNITS, type Unit } from '@/lib/units';
import type { UnitRow } from '@/lib/services/units';
import { UnitsDialog } from '@/components/screens/UnitsDialog';
import { stagedYield, validYield } from '@/domain/recipes/yield-stages';
import { BAD, parsePct, stagePct } from '@/components/recipes/StagesDialog';

const PAGE = 60;

export interface ItemsProps {
  items: IngredientDto[];
  brands: { id: string; name: string; code: string }[];
  priceDate: string;
  /** the unit list (D-103) for the purchase and inventory unit selects */
  units: UnitRow[];
}

interface ItemForm {
  id: string | null;
  version: number;
  code: string;
  name: string;
  uom: string;
  price: string;
  category: string;
  subcategory: string;
  shared: boolean;
  brandIds: string[];
  flag: string;
  /** default yield stages in percent (D-93): blank or 0 = 100% */
  thaw: string;
  cut: string;
  cook: string;
  /** purchase / inventory unit and the base units in one of it (D-102); the factor is typed only for a pack unit */
  pUnit: string;
  pFactor: string;
  iUnit: string;
  iFactor: string;
  /** D-106: the price of one purchase unit as typed; '' = show it derived from the price per base unit */
  pack: string;
  busy: boolean;
}

/** What a unit means for an item priced in `uom`: its factor, or why it does not fit. null = nothing to show. */
function unitFit(units: UnitRow[], code: string, uom: string, typed: string) {
  const def = units.find((u) => u.code === code);
  if (!def) return null;
  const n = typed.trim() === '' ? null : Number(typed);
  return { def, fit: fitUnit(def, uom as Unit, n) };
}

/** Legacy vItems (3730): search, brand and category filters, 60 per page, create/edit/delete modal. */
export function ItemsScreen({ items, brands, priceDate, units }: ItemsProps) {
  const router = useRouter();
  const toast = useToast();
  const modal = useModal();
  const can = usePerm();
  const io = useItemIO(brands);
  const [iq, setIq] = useState('');
  const [ibrand, setIbrand] = useState('');
  const [icat, setIcat] = useState('');
  const [ipage, setIpage] = useState(0);

  const brandById = useMemo(() => new Map(brands.map((b) => [b.id, b])), [brands]);
  const cats = useMemo(() => [...new Set(items.map((i) => i.subcategory))].sort(), [items]);
  const list = useMemo(() => {
    const q = iq.toLowerCase();
    return items.filter((i) => {
      if (ibrand === '__shared') {
        if (i.brandIds.length) return false;
      } else if (ibrand && !i.brandIds.includes(ibrand)) return false;
      if (icat && i.subcategory !== icat) return false;
      if (!q) return true;
      return `${i.code} ${i.name}`.toLowerCase().includes(q);
    });
  }, [items, iq, ibrand, icat]);
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = list.slice(ipage * PAGE, (ipage + 1) * PAGE);
  const sharedN = items.filter((i) => !i.brandIds.length).length;

  function edit(it: IngredientDto | null) {
    const st = createStore<ItemForm>({
      id: it?.id ?? null,
      version: it?.version ?? 0,
      code: it?.code ?? '',
      name: it?.name ?? '',
      uom: it?.uom ?? 'Gram',
      price: it && it.price != null ? String(it.price) : '',
      category: it?.category ?? '',
      subcategory: it?.subcategory ?? '',
      shared: !it || !it.brandIds.length,
      brandIds: it?.brandIds ?? [],
      flag: it?.flag ?? '',
      thaw: stagePct(it?.yThaw ?? null),
      cut: stagePct(it?.yCut ?? null),
      cook: stagePct(it?.yCook ?? null),
      pUnit: it?.purchaseUnit ?? it?.uom ?? 'Gram',
      pFactor: it && it.purchaseUnit !== it.uom ? String(it.purchaseFactor ?? '') : '',
      iUnit: it?.inventoryUnit ?? it?.uom ?? 'Gram',
      iFactor: it && it.inventoryUnit !== it.uom ? String(it.inventoryFactor ?? '') : '',
      pack: '',
      busy: false,
    });
    const body = () => {
      const f = st.get();
      const p = f.price.trim();
      if (!f.code.trim()) return (toast('Code is required'), null);
      if (p !== '' && !isFinite(Number(p))) return (toast('Price must be a number'), null);
      const yThaw = parsePct(f.thaw);
      const yCut = parsePct(f.cut);
      const yCook = parsePct(f.cook);
      if (yThaw === BAD || yCut === BAD || yCook === BAD)
        return (toast('Each stage must be above 0%, and the three together up to 1000%'), null);
      const prod = stagedYield({ yThaw, yCut, yCook });
      if (prod !== null && !validYield(prod))
        return (toast('Each stage must be above 0%, and the three together up to 1000%'), null);
      const pf = unitFit(units, f.pUnit, f.uom, f.pFactor);
      const inf = unitFit(units, f.iUnit, f.uom, f.iFactor);
      for (const x of [pf, inf]) if (x && !x.fit.ok) return (toast(x.fit.message), null);
      return {
        code: f.code.trim(),
        name: f.name.trim(),
        uom: f.uom,
        purchaseUnit: f.pUnit,
        purchaseFactor: pf?.fit.ok ? pf.fit.factor : undefined,
        inventoryUnit: f.iUnit,
        inventoryFactor: inf?.fit.ok ? inf.fit.factor : undefined,
        price: p === '' ? null : Number(p),
        category: f.category.trim(),
        subcategory: f.subcategory.trim(),
        flag: f.flag.trim(),
        brandIds: f.shared ? [] : f.brandIds,
        yThaw,
        yCut,
        yCook,
      };
    };
    async function save() {
      const b = body();
      if (!b) return;
      if (!b.name) return toast('Item name is required');
      if (b.price != null && b.price < 0) return toast('Price cannot be negative');
      st.set({ busy: true });
      try {
        if (it) await api('PATCH', `/api/ingredients/${it.id}`, { ...b, version: st.get().version });
        else await api('POST', '/api/ingredients', b);
        modal.close();
        toast('Ingredient saved');
        router.refresh();
      } catch (e) {
        st.set({ busy: false });
        toast(errText(e));
      }
    }
    async function del() {
      if (!it) return;
      st.set({ busy: true });
      try {
        await api('DELETE', `/api/ingredients/${it.id}`);
        modal.close();
        toast('Ingredient deleted');
        router.refresh();
      } catch (e) {
        st.set({ busy: false });
        toast(errText(e));
      }
    }
    modal.open({
      title: it ? 'Edit ingredient' : 'New ingredient',
      body: <ItemBody st={st} nw={!it} brands={brands} units={units} conv={it?.conv ?? null} />,
      foot: (
        <>
          <button className="btn o" onClick={modal.close}>
            Cancel
          </button>
          {it && (
            <button className="btn d" onClick={del}>
              Delete
            </button>
          )}
          <button className="btn" onClick={save}>
            Save
          </button>
        </>
      ),
    });
  }

  return (
    <>
      <Acts>
        <button className="btn o" onClick={io.template}>
          {'⤓'} Template
        </button>
        <Perm perm="units.edit">
          <button
            className="btn o"
            onClick={() =>
              modal.open({
                title: 'Units',
                body: <UnitsDialog initial={units} onChange={() => router.refresh()} />,
                foot: (
                  <button className="btn o" onClick={modal.close}>
                    Close
                  </button>
                ),
              })
            }
          >
            Units
          </button>
        </Perm>
        <Perm perm="items.edit">
          <button className="btn o" onClick={io.upload}>
            Upload price list
          </button>
        </Perm>
        <Perm perm="items.edit">
          <button className="btn" onClick={() => edit(null)}>
            + New Ingredient
          </button>
        </Perm>
      </Acts>
      {!can('items.edit') && (
        <div className="rolebar">
          <b>Read only.</b> Purchase prices can only be changed by Cost Control or management. You can still search and
          export.
        </div>
      )}
      <div className="row" style={s('grid-template-columns:1fr 210px 210px;margin-bottom:16px;max-width:940px')}>
        <input
          id="q_it"
          type="text"
          placeholder="Search by code or name..."
          value={iq}
          onChange={(e) => {
            setIq(e.target.value);
            setIpage(0);
          }}
        />
        <select
          value={ibrand}
          onChange={(e) => {
            setIbrand(e.target.value);
            setIpage(0);
          }}
        >
          <option value="">Every brand ({items.length})</option>
          <option value="__shared">Shared only ({sharedN})</option>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} ({items.filter((i) => i.brandIds.includes(b.id)).length})
            </option>
          ))}
        </select>
        <select
          value={icat}
          onChange={(e) => {
            setIcat(e.target.value);
            setIpage(0);
          }}
        >
          <option value="">All categories</option>
          {cats.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <div style={s('font-size:12px;color:var(--mute);margin-bottom:10px')}>
        Showing {page.length} of {total} {'·'} prices effective {priceDate}
      </div>
      <div className="tw">
        <table>
          <thead>
            <tr>
              <th style={s('width:130px')}>Code</th>
              <th>Item Name</th>
              <th className="c" style={s('width:70px')}>
                UOM
              </th>
              <th className="n" style={s('width:110px')}>
                Price / unit
              </th>
              <th className="n" style={s('width:110px')}>
                Buy as
              </th>
              <th className="n" style={s('width:90px')}>
                Yield
              </th>
              <th style={s('width:120px')}>Available To</th>
              <th style={s('width:140px')}>Sub Category</th>
              <th className="c" style={s('width:80px')}>
                Status
              </th>
              <th style={s('width:70px')}></th>
            </tr>
          </thead>
          <tbody>
            {page.map((i) => (
              <tr key={i.id}>
                <td className="mono" style={s('color:var(--org-dk);font-weight:700')}>
                  {i.code}
                </td>
                <td>
                  {i.name}
                  {i.flag && <div style={s('font-size:10.5px;color:var(--bad);margin-top:2px')}>{i.flag}</div>}
                </td>
                <td className="c" style={s('font-size:11.5px;color:var(--mute)')}>
                  {i.uom}
                </td>
                <td className="n mono">
                  {i.price == null ? <span className="pill p-bad">missing</span> : cur(i.price, 6)}
                </td>
                <td
                  className="n mono"
                  title={`Purchase ${i.purchaseUnit ?? i.uom} · Cooking ${i.conv?.recipeUnit ?? i.uom} · Inventory ${i.inventoryUnit ?? i.uom}`}
                >
                  {i.purchaseUnit && i.purchaseUnit !== i.uom ? `${i.purchaseUnit} · ${i.purchaseFactor}` : ''}
                </td>
                <td
                  className="n mono"
                  title={
                    stagedYield(i) === null
                      ? undefined
                      : `Thawing ${stagePct(i.yThaw ?? null) || 100}% · Cutting ${stagePct(i.yCut ?? null) || 100}% · Cooking ${stagePct(i.yCook ?? null) || 100}%`
                  }
                >
                  {stagedYield(i) === null ? '' : `${stagePct(stagedYield(i))}%`}
                </td>
                <td>
                  {!i.brandIds.length ? (
                    <span className="pill p-gr">Shared</span>
                  ) : (
                    i.brandIds.map((id, k) => {
                      const b = brandById.get(id);
                      return b ? (
                        <span key={id}>
                          {k > 0 && ' '}
                          <span className="pill p-sub" title={b.name}>
                            {b.code}
                          </span>
                        </span>
                      ) : null;
                    })
                  )}
                </td>
                <td style={s('font-size:12px')}>{i.subcategory}</td>
                <td className="c">
                  {i.flag ? <span className="pill p-warn">review</span> : <span className="pill p-ok">ok</span>}
                </td>
                <td className="c">
                  <Perm perm="items.edit">
                    <button className="btn sm o" onClick={() => edit(i)}>
                      Edit
                    </button>
                  </Perm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div style={s('display:flex;gap:6px;justify-content:center;margin-top:16px')}>
          {Array.from({ length: pages }, (_, p) => p)
            .filter((p) => Math.abs(p - ipage) < 4 || p === 0 || p === pages - 1)
            .map((p) => (
              <button key={p} className={`btn sm ${p === ipage ? '' : 'o'}`} onClick={() => setIpage(p)}>
                {p + 1}
              </button>
            ))}
        </div>
      )}
    </>
  );
}

/** The price of one purchase unit: what was typed, else the price per base unit times the factor (10 digits, for display only). */
function packText(f: ItemForm, factor: number): string {
  if (f.pack !== '') return f.pack;
  const n = Number(f.price);
  return f.price.trim() === '' || !isFinite(n) ? '' : String(Number((n * factor).toPrecision(10)));
}

function UnitPick({
  label,
  st,
  unitKey,
  factorKey,
  units,
  uom,
}: {
  label: string;
  st: Store<ItemForm>;
  unitKey: 'pUnit' | 'iUnit';
  factorKey: 'pFactor' | 'iFactor';
  units: UnitRow[];
  uom: string;
}) {
  const f = useStore(st);
  const x = unitFit(units, f[unitKey], uom, f[factorKey]);
  const isBase = f[unitKey] === uom;
  return (
    <div className="field">
      <label className="fl">{label}</label>
      <select
        aria-label={label}
        value={f[unitKey]}
        onChange={(e) => st.set({ [unitKey]: e.target.value, [factorKey]: '', pack: '' })}
      >
        {units.map((u) => (
          <option key={u.code}>{u.code}</option>
        ))}
      </select>
      {x?.def.kind === 'pack' && !isBase ? (
        <input
          type="number"
          step="any"
          min="0"
          className="cell"
          style={s('margin-top:5px;text-align:right')}
          aria-label={`1 ${f[unitKey]} = ? ${uom}`}
          placeholder={`1 ${f[unitKey]} = ? ${uom}`}
          value={f[factorKey]}
          onChange={(e) => st.set({ [factorKey]: e.target.value, pack: '' })}
        />
      ) : (
        <div className="note" style={s('margin:5px 0 0')}>
          {isBase ? 'same as base' : !x ? '' : x.fit.ok ? `1 ${f[unitKey]} = ${x.fit.factor} ${uom}` : x.fit.message}
        </div>
      )}
    </div>
  );
}

function ItemBody({
  st,
  nw,
  brands,
  units,
  conv,
}: {
  st: Store<ItemForm>;
  nw: boolean;
  brands: ItemsProps['brands'];
  units: UnitRow[];
  conv: IngredientDto['conv'];
}) {
  const f = useStore(st);
  const pf = unitFit(units, f.pUnit, f.uom, f.pFactor);
  const packFactor = pf?.fit.ok ? pf.fit.factor : null;
  return (
    <>
      <div className="field">
        <label className="fl">Code</label>
        <input
          type="text"
          className="cell mono"
          value={f.code}
          readOnly={!nw}
          onChange={(e) => st.set({ code: e.target.value })}
        />
      </div>
      <div className="field">
        <label className="fl">Item Name</label>
        <input type="text" value={f.name} onChange={(e) => st.set({ name: e.target.value })} />
      </div>
      <div className="row r2">
        <div className="field">
          <label className="fl">UOM</label>
          <select value={f.uom} onChange={(e) => st.set({ uom: e.target.value })}>
            {UNITS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="fl">Price per unit</label>
          <input
            type="number"
            step="any"
            className="cell"
            value={f.price}
            onChange={(e) => st.set({ price: e.target.value, pack: '' })}
          />
        </div>
      </div>
      <div className="row r2">
        <div className="field">
          <label className="fl">Main Category</label>
          <input type="text" value={f.category} onChange={(e) => st.set({ category: e.target.value })} />
        </div>
        <div className="field">
          <label className="fl">Sub Category</label>
          <input type="text" value={f.subcategory} onChange={(e) => st.set({ subcategory: e.target.value })} />
        </div>
      </div>
      <div className="note" style={s('margin:0 0 6px')}>
        Default yields: the share of the weight kept after each stage. Leave blank or 0 for 100%. New recipe lines start
        with these values.
      </div>
      <div className="row" style={s('grid-template-columns:1fr 1fr 1fr')}>
        {(
          [
            ['thaw', 'Thawing %'],
            ['cut', 'Cutting / trimming %'],
            ['cook', 'Cooking %'],
          ] as const
        ).map(([key, label]) => (
          <div className="field" key={key}>
            <label className="fl">{label}</label>
            <input
              type="number"
              step="any"
              min="0"
              className="cell"
              style={s('text-align:right')}
              value={f[key]}
              placeholder="100"
              onChange={(e) => st.set({ [key]: e.target.value })}
            />
          </div>
        ))}
      </div>
      <div className="note" style={s('margin:0 0 6px')}>
        Units: the base unit above is what prices and recipes are costed in. A purchase or inventory unit is how you buy
        or count it; the number says how many base units it holds.
      </div>
      <div className="row r2">
        <UnitPick label="Purchase unit" st={st} unitKey="pUnit" factorKey="pFactor" units={units} uom={f.uom} />
        <UnitPick label="Inventory unit" st={st} unitKey="iUnit" factorKey="iFactor" units={units} uom={f.uom} />
      </div>
      {packFactor !== null && f.pUnit !== f.uom && (
        <div className="field">
          <label className="fl">Price per {f.pUnit}</label>
          <input
            type="number"
            step="any"
            min="0"
            className="cell"
            aria-label={`Price per ${f.pUnit}`}
            value={packText(f, packFactor)}
            onChange={(e) => {
              const t = e.target.value;
              const n = Number(t);
              // the price per base unit is the exact quotient, never rounded; blank clears it
              st.set({ pack: t, price: t.trim() === '' ? '' : isFinite(n) ? String(n / packFactor) : f.price });
            }}
          />
          <div className="note" style={s('margin:5px 0 0')}>
            Typing it fills the price per {f.uom} above ({f.pUnit} price divided by {packFactor}).
          </div>
        </div>
      )}
      <div className="note" style={s('margin:0 0 8px')}>
        Cooking unit:{' '}
        {conv ? `${conv.recipeUnit} (1 ${f.uom} = ${conv.factor} ${conv.recipeUnit}), set on Conv` : 'same as base'}
      </div>
      <div className="field">
        <label className="fl">Available to</label>
        <label
          style={s(
            'display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--line);border-radius:7px;margin-bottom:7px;background:var(--org-xl);cursor:pointer',
          )}
        >
          <input type="checkbox" checked={f.shared} onChange={(e) => st.set({ shared: e.target.checked })} />
          <b style={s('font-size:12.5px')}>Shared {'–'} every brand can use it</b>
        </label>
        <div
          style={{
            display: f.shared ? 'none' : 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 5,
            border: '1px solid var(--line)',
            borderRadius: 7,
            padding: 9,
          }}
        >
          {brands.map((b) => (
            <label key={b.id} style={s('display:flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer')}>
              <input
                type="checkbox"
                checked={f.brandIds.includes(b.id)}
                onChange={(e) =>
                  st.set({ brandIds: e.target.checked ? [...f.brandIds, b.id] : f.brandIds.filter((x) => x !== b.id) })
                }
              />
              {b.name}
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <label className="fl">Review flag</label>
        <input
          type="text"
          value={f.flag}
          placeholder="leave empty if fine"
          onChange={(e) => st.set({ flag: e.target.value })}
        />
      </div>
    </>
  );
}
