'use client';

import { useRouter } from 'next/navigation';
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

const PAGE = 60;

export interface ItemsProps {
  items: IngredientDto[];
  brands: { id: string; name: string; code: string }[];
  priceDate: string;
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
  busy: boolean;
}

/** Legacy vItems (3730): search, brand and category filters, 60 per page, create/edit/delete modal. */
export function ItemsScreen({ items, brands, priceDate }: ItemsProps) {
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
      busy: false,
    });
    const body = () => {
      const f = st.get();
      const p = f.price.trim();
      if (!f.code.trim()) return toast('Code is required'), null;
      if (p !== '' && !isFinite(Number(p))) return toast('Price must be a number'), null;
      return {
        code: f.code.trim(),
        name: f.name.trim(),
        uom: f.uom,
        price: p === '' ? null : Number(p),
        category: f.category.trim(),
        subcategory: f.subcategory.trim(),
        flag: f.flag.trim(),
        brandIds: f.shared ? [] : f.brandIds,
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
      body: <ItemBody st={st} nw={!it} brands={brands} />,
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
          <b>Read only.</b> Purchase prices can only be changed by Cost Control or management. You can still search and export.
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
                <td className="n mono">{i.price == null ? <span className="pill p-bad">missing</span> : cur(i.price, 6)}</td>
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

function ItemBody({ st, nw, brands }: { st: Store<ItemForm>; nw: boolean; brands: ItemsProps['brands'] }) {
  const f = useStore(st);
  return (
    <>
      <div className="field">
        <label className="fl">Code</label>
        <input type="text" className="cell mono" value={f.code} readOnly={!nw} onChange={(e) => st.set({ code: e.target.value })} />
      </div>
      <div className="field">
        <label className="fl">Item Name</label>
        <input type="text" value={f.name} onChange={(e) => st.set({ name: e.target.value })} />
      </div>
      <div className="row r2">
        <div className="field">
          <label className="fl">UOM</label>
          <select value={f.uom} onChange={(e) => st.set({ uom: e.target.value })}>
            {['Gram', 'Ml', 'Each', 'Slice'].map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="fl">Price per unit</label>
          <input type="number" step="any" className="cell" value={f.price} onChange={(e) => st.set({ price: e.target.value })} />
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
                onChange={(e) => st.set({ brandIds: e.target.checked ? [...f.brandIds, b.id] : f.brandIds.filter((x) => x !== b.id) })}
              />
              {b.name}
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <label className="fl">Review flag</label>
        <input type="text" value={f.flag} placeholder="leave empty if fine" onChange={(e) => st.set({ flag: e.target.value })} />
      </div>
    </>
  );
}
