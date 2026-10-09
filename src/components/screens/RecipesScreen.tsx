'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { NewRecipeButton } from '@/components/recipes/NewRecipeButton';
import { trashCount, useRecipeActions, type CardFacts } from '@/components/recipes/actions';
import { Acts } from '@/components/shell/Shell';
import { Perm } from '@/components/shared/Perm';
import { s } from '@/components/ui';
import { cur, fcClass, pct } from '@/lib/format';
import type { RecipeRow } from '@/lib/screens/rows';

const RPAGE = 50;
/** Chicken first, then the rest of the main courses, then everything else - the order the kitchen thinks in. */
const ORD = [
  'Main Course - Chicken',
  'Main Course - Lamb',
  'Main Course - Veal',
  'Main Course - Beef',
  'Main Course - Fish',
  'Main Course',
  'Breakfast',
  'Soup',
];

export interface RecipesProps {
  rows: RecipeRow[];
  brands: { id: string; name: string }[];
  workspaceId: string;
  target: number;
}

const facts = (r: RecipeRow): CardFacts => ({
  id: r.id,
  code: r.code,
  name: r.name,
  type: r.type,
  locked: r.status === 'LOCKED',
  food: r.c.food,
  fcPct: r.c.fcPct,
  sp: r.c.sp,
  net: r.c.net,
  err: r.c.err,
});

/** Legacy vRecipes (2752). The page loads the lightweight list once; filtering and paging happen here so typing never remounts. */
export function RecipesScreen({ rows, brands, workspaceId, target }: RecipesProps) {
  const router = useRouter();
  const act = useRecipeActions(target);
  const [rq, setRq] = useState('');
  const [rbrand, setRbrand] = useState('');
  const [rstatus, setRstatus] = useState('');
  const [rcat, setRcat] = useState('');
  const [rpage, setRpage] = useState(0);
  const [sel, setSel] = useState<Set<string>>(new Set());

  const brandName = useMemo(() => new Map(brands.map((b) => [b.id, b.name])), [brands]);
  const ws = brands.find((b) => b.id === workspaceId) ?? null;

  const inBrandStatus = (r: RecipeRow) => {
    if (rbrand) {
      if (r.brandId !== rbrand) return false;
    } else if (workspaceId && r.brandId !== workspaceId) return false;
    if (rstatus && (r.status === 'LOCKED' ? 'locked' : 'draft') !== rstatus) return false;
    return true;
  };
  const base = useMemo(() => rows.filter(inBrandStatus), [rows, rbrand, rstatus, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(() => {
    const q = rq.trim().toLowerCase();
    return base.filter((r) => {
      if (rcat && (r.cat || '').trim() !== rcat) return false;
      if (!q) return true;
      return `${r.name} ${r.code} ${r.cat || ''} ${brandName.get(r.brandId) ?? ''}`.toLowerCase().includes(q);
    });
  }, [base, rq, rcat, brandName]);

  const pages = Math.max(1, Math.ceil(list.length / RPAGE));
  const page = list.slice(rpage * RPAGE, (rpage + 1) * RPAGE);
  const allSel = page.length > 0 && page.every((r) => sel.has(r.id));
  const nLock = list.filter((r) => r.status === 'LOCKED').length;

  const cats = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of base) {
      const k = (r.cat || '').trim() || 'NOCAT';
      c.set(k, (c.get(k) ?? 0) + 1);
    }
    return [...c.keys()].sort((a, b) => {
      const ia = ORD.indexOf(a),
        ib = ORD.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.localeCompare(b);
    }).map((k) => [k, c.get(k)!] as const);
  }, [base]);

  const selected = rows.filter((r) => sel.has(r.id));
  const reset = () => setRpage(0);
  const clearSel = () => setSel(new Set());
  const toggle = (id: string, on: boolean) =>
    setSel((p) => {
      const n = new Set(p);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const nUndo = trashCount();

  return (
    <>
      <Acts>
        <button className="btn o" onClick={() => window.dispatchEvent(new CustomEvent('isfc:export-recipes'))}>
          Export CSV
        </button>
        <Perm perm="recipe.create">
          <button className="btn o" onClick={() => window.dispatchEvent(new CustomEvent('isfc:import-recipes'))}>
            {'⬆'} Upload recipes
          </button>
        </Perm>
        {nUndo > 0 && (
          <button className="btn o" onClick={act.undoDelete}>
            {'↺'} Restore {nUndo}
          </button>
        )}
        <NewRecipeButton />
      </Acts>
      {sel.size > 0 && (
        <div className="selbar">
          <b>
            {sel.size} card{sel.size === 1 ? '' : 's'} selected
          </b>
          <span className="sp"></span>
          <button className="lite" onClick={() => act.lock(selected.map(facts), clearSel)}>
            Lock &amp; approve
          </button>
          <button
            className="lite"
            onClick={() => {
              const ids = selected.filter((r) => r.status === 'LOCKED').map((r) => r.id);
              if (!ids.length) return;
              act.unlock(ids, undefined, clearSel);
            }}
          >
            Unlock
          </button>
          <button className="lite" onClick={clearSel}>
            Clear
          </button>
          <button className="dgr" onClick={() => act.confirmDelete(selected.map(facts), clearSel)}>
            Delete selected
          </button>
        </div>
      )}
      <div className="row" style={s('grid-template-columns:1fr 190px 170px;max-width:840px;margin-bottom:14px')}>
        <input
          id="q_rec"
          type="text"
          placeholder="Search name, code, category..."
          value={rq}
          onChange={(e) => {
            setRq(e.target.value);
            reset();
          }}
        />
        <select
          value={rbrand}
          onChange={(e) => {
            setRbrand(e.target.value);
            reset();
          }}
        >
          <option value="">{ws ? ws.name + ' (scoped)' : 'All brands'}</option>
          {brands.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        <select
          value={rstatus}
          onChange={(e) => {
            setRstatus(e.target.value);
            reset();
          }}
        >
          <option value="">Any status</option>
          <option value="draft">Draft only</option>
          <option value="locked">Locked only</option>
        </select>
      </div>
      {cats.length >= 2 && (
        <div style={s('display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px')}>
          <button
            className={`btn ${rcat === '' ? '' : 'o'}`}
            onClick={() => {
              setRcat('');
              reset();
            }}
          >
            All categories ({base.length})
          </button>
          {cats.map(([k, n]) => (
            <button
              key={k}
              className={`btn ${rcat === k ? '' : 'o'}`}
              onClick={() => {
                setRcat(k === 'NOCAT' ? '' : k);
                reset();
              }}
            >
              {k === 'NOCAT' ? '— no category —' : k} ({n})
            </button>
          ))}
        </div>
      )}
      <div style={s('font-size:12px;color:var(--mute);margin-bottom:10px')}>
        {list.length} card{list.length === 1 ? '' : 's'} {'·'} {nLock} locked
        {pages > 1 ? ` · page ${rpage + 1} of ${pages}` : ''}
      </div>

      {!list.length ? (
        <div className="card">
          <div className="empty">
            <div className="big">{'▤'}</div>
            <p>
              {rq || rbrand || rstatus
                ? 'Nothing matches that filter.'
                : ws
                  ? `No cards in ${ws.name} yet.`
                  : 'No recipe cards yet.'}
            </p>
            <p style={s('margin-top:14px')}>
              <NewRecipeButton />
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th className="ck">
                    <input
                      type="checkbox"
                      checked={allSel}
                      onChange={(e) => page.forEach((r) => toggle(r.id, e.target.checked))}
                    />
                  </th>
                  <th style={s('width:130px')}>Code</th>
                  <th>Recipe</th>
                  <th style={s('width:110px')}>Brand</th>
                  <th className="c" style={s('width:90px')}>
                    Status
                  </th>
                  <th className="c" style={s('width:100px')}>
                    Type
                  </th>
                  <th className="c" style={s('width:110px')}>
                    Batch Output
                  </th>
                  <th className="n" style={s('width:100px')}>
                    Cost / Portion
                  </th>
                  <th className="n" style={s('width:95px')}>
                    Sales Price
                  </th>
                  <th className="c" style={s('width:78px')}>
                    FC %
                  </th>
                  <th className="c" style={s('width:190px')}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.map((r) => {
                  const c = r.c;
                  const lk = r.status === 'LOCKED';
                  return (
                    <tr key={r.id} className={sel.has(r.id) ? 'sel' : ''}>
                      <td className="ck">
                        <input type="checkbox" checked={sel.has(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} />
                      </td>
                      <td className="mono" style={s('color:var(--org-dk);font-weight:700')}>
                        {r.code}
                      </td>
                      <td onClick={() => router.push(`/edit/${r.id}`)} style={s('cursor:pointer')}>
                        <b>{r.name}</b>
                        <div style={s('font-size:11px;color:var(--mute)')}>
                          {r.cat || ''} {'·'} {r.nLines} ingredients
                        </div>
                      </td>
                      <td>
                        {r.brandId ? (
                          <span className="pill p-sub">{brandName.get(r.brandId) ?? ''}</span>
                        ) : (
                          <span style={s('color:var(--mute);font-size:11.5px')}>{'—'}</span>
                        )}
                      </td>
                      <td className="c">
                        {lk ? (
                          <span className="pill p-lock">{'🔒'} Locked</span>
                        ) : (
                          <span className="pill p-draft">Draft</span>
                        )}
                      </td>
                      <td className="c">
                        <span className={`pill ${r.type === 'sub' ? 'p-sub' : 'p-menu'}`}>{r.type === 'sub' ? 'Sub' : 'Menu'}</span>
                      </td>
                      <td className="c">
                        {cur(c.bOut, 0)} {c.bUom}
                        <div style={s('font-size:10.5px;color:var(--mute)')}>
                          {c.out} portion{c.out === 1 ? '' : 's'}
                        </div>
                      </td>
                      <td className="n">{cur(c.food)}</td>
                      <td className="n">{c.sp ? cur(c.sp) : '-'}</td>
                      <td className="c">
                        <span className={`pill ${fcClass(c.fcPct, target)}`}>{pct(c.fcPct)}</span>
                      </td>
                      <td className="c" style={s('white-space:nowrap')}>
                        <button className="btn sm o" onClick={() => router.push(`/edit/${r.id}`)}>
                          {lk ? 'View' : 'Edit'}
                        </button>{' '}
                        <button className="btn sm o" onClick={() => act.duplicate(r.id)}>
                          Copy
                        </button>{' '}
                        {lk ? (
                          <button className="btn sm o" onClick={() => act.unlock([r.id], r.code)}>
                            Unlock
                          </button>
                        ) : (
                          <button className="btn sm g" onClick={() => act.lock([facts(r)])}>
                            Lock
                          </button>
                        )}{' '}
                        <button className="btn sm d" onClick={() => act.confirmDelete([facts(r)])}>
                          Del
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div style={s('display:flex;gap:6px;justify-content:center;margin-top:16px;flex-wrap:wrap')}>
              {Array.from({ length: pages }, (_, i) => i)
                .filter((i) => Math.abs(i - rpage) < 4 || i === 0 || i === pages - 1)
                .map((i) => (
                  <button key={i} className={`btn sm ${i === rpage ? '' : 'o'}`} onClick={() => setRpage(i)}>
                    {i + 1}
                  </button>
                ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
