'use client';

import { useRouter } from '@/components/shell/nav-progress';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Acts, PageTitle } from '@/components/shell/Shell';
import { api, ClientApiError, errText, uploadImage } from '@/components/shared/api-client';
import { imgError, readPhoto } from '@/components/shared/images';
import { CommitInput } from '@/components/shared/inputs';
import { useModal } from '@/components/shared/Modal';
import { Perm } from '@/components/shared/Perm';
import { usePerm, useRoleDef } from '@/components/shared/session-context';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { brandVarsMap, brandPalette } from '@/lib/brand/palette';
import { cur, fcClass, pct } from '@/lib/format';
import type { RecipeDetail } from '@/lib/services/recipe-detail';
import { CostBreakdownButton, openBreakdown } from './CostBreakdown';
import { LineRow, type EditLine } from './LineRow';
import { openBrowse } from './Browse';
import { LockedCard } from './LockedCard';
import { useRecipeActions, type CardFacts } from './actions';
import { cardHtml, usePrintMenu, type PrintBrand } from './print';
import { printStore } from '@/components/shell/print-store';

export interface EditProps {
  detail: RecipeDetail;
  brand: (PrintBrand & { id: string }) | null;
  brands: { id: string; name: string; code: string }[];
}

type SavePatch = Record<string, unknown>;

/** Legacy vEdit (3089): the card editor. Fields commit on change (autosave, version-checked), costs come back from the server. */
export function EditScreen(props: EditProps) {
  const { detail: first, brand, brands } = props;
  const router = useRouter();
  const toast = useToast();
  const modal = useModal();
  const can = usePerm();
  const roleDef = useRoleDef();
  const [d, setD] = useState(first);
  const verRef = useRef(first.recipe.version);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef<SavePatch[]>([]);
  const flushing = useRef(false);
  const act = useRecipeActions(first.settings.target);
  const printMenu = usePrintMenu();

  // a router.refresh() (after lock/unlock/duplicate...) brings a newer server copy: adopt it
  useEffect(() => {
    if (first.recipe.version >= verRef.current) {
      verRef.current = first.recipe.version;
      setD(first);
    }
  }, [first]);

  const r = d.recipe;
  const c = d.view.cost;
  const st = d.settings;
  const locked = r.status === 'LOCKED';
  const facts: CardFacts = useMemo(
    () => ({
      id: r.id,
      code: r.code,
      name: r.name,
      type: r.type === 'SUB' ? 'sub' : 'menu',
      locked,
      food: c.food,
      fcPct: c.fcPct,
      sp: c.sp,
      net: c.net,
      err: c.err,
    }),
    [r.id, r.code, r.name, r.type, locked, c.food, c.fcPct, c.sp, c.net, c.err],
  );

  /**
   * Optimistic local edit + serialised PATCH; the server answers with the recomputed cost view.
   * Edits made while a PATCH is in flight (or in the same tick) are merged into ONE follow-up request (last value per
   * field wins; `lines` and `method` are always full arrays, so that is exact). The first edit is sent at once. A price
   * edit is never merged with other fields: it needs `recipe.price`, everything else `recipe.edit`, so each keeps failing
   * or succeeding on its own.
   */
  const save = useCallback(
    (patch: SavePatch, local?: Partial<RecipeDetail['recipe']>) => {
      if (local) setD((p) => ({ ...p, recipe: { ...p.recipe, ...local } }));
      const isPrice = (x: SavePatch) => 'sellingPrice' in x;
      const last = pending.current[pending.current.length - 1];
      if (last && isPrice(last) === isPrice(patch)) pending.current[pending.current.length - 1] = { ...last, ...patch };
      else pending.current.push(patch);
      if (flushing.current) return;
      flushing.current = true;
      queue.current = (async () => {
        await Promise.resolve(); // same-tick edits join the first request
        try {
          while (pending.current.length) {
            const next = pending.current.shift()!;
            try {
              const nd = await api<RecipeDetail>('PATCH', `/api/recipes/${first.recipe.id}`, {
                version: verRef.current,
                ...next,
              });
              verRef.current = nd.recipe.version;
              setD((p) => ({
                ...p,
                view: nd.view,
                settings: nd.settings,
                packaging: nd.packaging,
                recipe: { ...p.recipe, version: nd.recipe.version, code: nd.recipe.code, history: nd.recipe.history },
              }));
            } catch (e) {
              toast(errText(e));
              if (e instanceof ClientApiError && (e.status === 409 || e.status === 422)) router.refresh();
            }
          }
        } finally {
          flushing.current = false;
        }
      })();
    },
    [first.recipe.id, router, toast],
  );

  const canEdit = can('recipe.edit') && !locked;

  // ------------------------------------------------------------------ fields
  const setF = (k: 'name' | 'category', v: string) => save({ [k]: v }, { [k]: v } as never);
  const setType = (t: 'MENU' | 'SUB') => save({ type: t }, { type: t });
  const setBrandId = (id: string) => save({ brandId: id }, { brandId: id });
  const setOutput = (v: string) => {
    const n = Math.max(0, parseFloat(v) || 0);
    if (n > 0) save({ output: n }, { output: n });
    else toast('Output must be above zero');
  };
  const setBatchOut = (v: string) => {
    const n = parseFloat(v);
    const val = isFinite(n) && n >= 0 ? n : 0;
    save(
      { batchOut: val, ...(r.type === 'SUB' ? { subQty: val } : {}) },
      { batchOut: val, ...(r.type === 'SUB' ? { subQty: val } : {}) },
    );
  };
  const setBatchUom = (u: 'Gram' | 'Ml' | 'Each') =>
    save(
      { batchUom: u, ...(r.type === 'SUB' ? { subUom: u } : {}) },
      { batchUom: u, ...(r.type === 'SUB' ? { subUom: u } : {}) },
    );
  const autoBatchOut = () => {
    const v = +c.autoOut.toFixed(3);
    save(
      { batchOut: v, batchUom: c.autoUom, ...(r.type === 'SUB' ? { subQty: v, subUom: c.autoUom } : {}) },
      { batchOut: v, batchUom: c.autoUom, ...(r.type === 'SUB' ? { subQty: v, subUom: c.autoUom } : {}) },
    );
    toast(`Batch output set to ${cur(c.autoOut, 1)} ${c.autoUom}`);
  };
  const setPrice = (v: string) => {
    const n = parseFloat(v);
    save({ sellingPrice: isFinite(n) && n >= 0 ? n : 0 }, { sellingPrice: isFinite(n) && n >= 0 ? n : 0 });
  };
  const regenCode = () => save({ regenCode: true });

  // ------------------------------------------------------------------ lines / method
  const lines: EditLine[] = r.lines.map((l) => ({
    code: l.code,
    qty: l.qty,
    unit: l.unit as EditLine['unit'],
    y: l.y,
    yp: l.yp,
    yThaw: l.yThaw ?? null,
    yCut: l.yCut ?? null,
    yCook: l.yCook ?? null,
  }));
  // Edits are built from the newest lines, not the last render's copy, so two edits in one tick never overwrite each other.
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const commitLines = (next: EditLine[]) => {
    const withBlank = next.length
      ? next
      : [{ code: '', qty: 0, unit: 'Gram' as const, y: 1, yp: null, yThaw: null, yCut: null, yCook: null }];
    linesRef.current = withBlank;
    save(
      { lines: withBlank },
      {
        lines: withBlank.map((l, i) => ({
          sortOrder: i,
          code: l.code,
          qty: l.qty,
          unit: l.unit,
          y: l.y,
          yp: l.yp,
          yThaw: l.yThaw,
          yCut: l.yCut,
          yCook: l.yCook,
        })),
      },
    );
  };
  const setLine = (i: number, patch: Partial<EditLine>) =>
    commitLines(linesRef.current.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const setMethod = (m: string[]) => save({ method: m }, { method: m });

  // ------------------------------------------------------------------ photo
  async function setPhoto(file: File | undefined) {
    if (!file || !canEdit) return;
    toast('Processing the photo…');
    try {
      const out = await readPhoto(file);
      const res = await uploadImage(`/api/recipes/${r.id}/photo`, out.blob);
      setD((p) => ({ ...p, recipe: { ...p.recipe, photoUrl: res.url, photoSha: res.sha256, photoSize: res.size } }));
      toast(`Photo added · ${out.w}×${out.h} · ${out.kb} KB`);
    } catch (e) {
      toast(e instanceof ClientApiError ? e.message : imgError(e));
    }
  }
  async function removePhoto() {
    if (!canEdit || !r.photoUrl) return;
    try {
      await api('DELETE', `/api/recipes/${r.id}/photo`);
      setD((p) => ({ ...p, recipe: { ...p.recipe, photoUrl: null, photoSha: null, photoSize: null } }));
      toast('Photo removed');
    } catch (e) {
      toast(errText(e));
    }
  }
  function viewPhoto() {
    if (!r.photoUrl) return;
    modal.open({
      title: r.name || 'Dish photo',
      body: (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={r.photoUrl} alt="" style={s('width:100%;border-radius:9px;display:block')} />
          <div style={s('font-size:11.5px;color:var(--mute);margin-top:9px')}>
            {Math.round((r.photoSize ?? 0) / 1024)} KB stored.
          </div>
        </>
      ),
    });
  }

  const pal = brandPalette(brand ? { color: brand.color, ink: brand.ink } : null);
  const bv = brandVarsMap(pal) as React.CSSProperties;
  const logo = brand?.logoUrl ?? '/assets/logo.png';
  const batchDp = c.bUom === 'Each' ? 0 : 1;

  const title = r.name || 'Recipe Card';
  // Ctrl+P on the editor prints the card, as legacy syncPrintTarget did
  useEffect(() => {
    if (locked) return; // the locked view owns the print layer
    printStore.set({ html: cardHtml(d, brand) });
    return () => printStore.set({ html: '' });
  }, [d, brand, locked]);
  if (locked)
    return (
      <>
        <PageTitle title={title} sub={`${brand?.name || 'no brand'} · ${r.code || 'no code'} · LOCKED`} />
        <LockedCard
          d={d}
          brand={brand}
          act={act}
          onPrint={() => printMenu(d, brand)}
          onDone={() => router.push('/recipes')}
        />
      </>
    );

  return (
    <>
      <PageTitle title={title} sub={`${r.code || 'no code'} · ${r.category || 'uncategorised'}`} />
      <Acts>
        <button className="btn o" onClick={() => router.push('/recipes')}>
          {'←'} All cards
        </button>
        <button className="btn o" onClick={() => act.duplicate(r.id)}>
          Duplicate
        </button>
        <button className="btn o" onClick={() => printMenu(d, brand)}>
          Print
        </button>
        <button className="btn d" onClick={() => act.confirmDelete([facts], () => router.push('/recipes'))}>
          Delete
        </button>
        <button className="btn g" onClick={() => act.lock([facts])}>
          {'🔒'} Lock &amp; approve
        </button>
      </Acts>

      {!can('recipe.edit') && (
        <div className="rolebar">
          <b>Read only.</b> Your role ({roleDef.label}) can view and print this card but not change it.
        </div>
      )}
      {can('recipe.edit') && !can('recipe.price') && (
        <div className="rolebar">
          <b>Sales price locked.</b> You can build and cost this card, but only Cost Control or management can set the
          selling price.
        </div>
      )}
      <div className="row" style={s('grid-template-columns:1fr 340px;align-items:start')}>
        <div>
          <div className="card" style={{ ...s('margin-bottom:18px;overflow:hidden'), ...bv }}>
            <div className="rchead">
              {r.photoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="rcphoto" src={r.photoUrl} alt="" onClick={viewPhoto} title="Click to enlarge" />
              )}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={logo} alt="" />
              <div className="rchtxt">
                <h2>{r.name || 'Untitled recipe'}</h2>
                <div className="co">International Specialized Food Co.</div>
                <div className="mt">
                  {brand && (
                    <>
                      <b style={s('color:var(--grn-dk)')}>{brand.name}</b> {'·'}{' '}
                    </>
                  )}
                  {r.code || 'no code'} {'·'} {r.category || 'uncategorised'} {'·'}{' '}
                  {r.type === 'SUB' ? 'Sub-Recipe' : 'Menu Item'}
                  <span className="pill p-draft" style={s('margin-left:6px')}>
                    Draft
                  </span>
                </div>
              </div>
              <div className="rchout">
                <span>Batch Output</span>
                <b>
                  {cur(c.bOut, batchDp)} <i>{c.bUom}</i>
                </b>
                <span>
                  {c.out} portion{c.out === 1 ? '' : 's'} {'·'} {cur(c.portion, batchDp)} {c.bUom} each
                </span>
              </div>
            </div>
            <div className="bd">
              <div className="row r3">
                <div className="field">
                  <label className="fl">Recipe Code</label>
                  <div style={s('display:flex;gap:6px')}>
                    <Perm perm="recipe.edit">
                      <CommitInput
                        className="cell mono"
                        value={r.code}
                        placeholder="auto"
                        onCommit={(v) => save({ code: v.trim() }, { code: v.trim() })}
                      />
                    </Perm>
                    <Perm perm="recipe.edit">
                      <button className="btn sm o" onClick={regenCode} title="Generate the next free code">
                        {'↻'}
                      </button>
                    </Perm>
                  </div>
                </div>
                <div className="field" style={s('grid-column:span 2')}>
                  <label className="fl">Item Name</label>
                  <Perm perm="recipe.edit">
                    <CommitInput className="cell" value={r.name} onCommit={(v) => setF('name', v)} />
                  </Perm>
                </div>
              </div>
              <div className="row r3">
                <div className="field">
                  <label className="fl">Brand</label>
                  <Perm perm="recipe.edit">
                    <select value={r.brandId} onChange={(e) => setBrandId(e.target.value)}>
                      {brands.map((bn) => (
                        <option key={bn.id} value={bn.id}>
                          {bn.name} ({bn.code})
                        </option>
                      ))}
                    </select>
                  </Perm>
                </div>
                <div className="field">
                  <label className="fl">Sub Category</label>
                  <Perm perm="recipe.edit">
                    <CommitInput value={r.category || ''} onCommit={(v) => setF('category', v)} />
                  </Perm>
                </div>
                <div className="field">
                  <label className="fl">Type</label>
                  <Perm perm="recipe.edit">
                    <select value={r.type} onChange={(e) => setType(e.target.value as 'MENU' | 'SUB')}>
                      <option value="MENU">Menu Item</option>
                      <option value="SUB">Sub-Recipe</option>
                    </select>
                  </Perm>
                </div>
              </div>
              <div className="row r3">
                <div className="field">
                  <label className="fl">Output (portions)</label>
                  <div style={s('display:flex;gap:6px')}>
                    <Perm perm="recipe.edit">
                      <CommitInput
                        className="cell"
                        type="number"
                        step="1"
                        min="1"
                        value={r.output || 1}
                        onCommit={setOutput}
                      />
                    </Perm>
                    <CostBreakdownButton
                      onClick={() =>
                        openBreakdown(modal, d, r.code, r.name, r.type === 'SUB', () => router.push('/items'))
                      }
                    />
                  </div>
                  <div style={s('font-size:11px;color:var(--mute);margin-top:4px')}>
                    {c.out > 1 ? `Batch cost divided by ${c.out} portions.` : 'One portion per batch.'}
                  </div>
                </div>
              </div>
              <div className="row r3" style={s('align-items:end')}>
                <div className="field">
                  <label className="fl">Dish Photo</label>
                  <div className={`phbox ${r.photoUrl ? 'has' : ''}`}>
                    {r.photoUrl ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={r.photoUrl} alt="" onClick={viewPhoto} title="Click to enlarge" />
                        <div className="phact">
                          <Perm perm="recipe.edit">
                            <label className="btn sm o">
                              Replace
                              <input
                                type="file"
                                accept="image/*"
                                style={s('display:none')}
                                onChange={(e) => {
                                  setPhoto(e.target.files?.[0]);
                                  e.target.value = '';
                                }}
                              />
                            </label>
                          </Perm>
                          <Perm perm="recipe.edit">
                            <button className="btn sm d" onClick={removePhoto}>
                              Remove
                            </button>
                          </Perm>
                          <span className="phkb">{Math.round((r.photoSize ?? 0) / 1024) || ''} KB</span>
                        </div>
                      </>
                    ) : (
                      <Perm perm="recipe.edit">
                        <label className="phadd">
                          <span className="pl">{'＋'}</span>
                          <span>Add a photo</span>
                          <input
                            type="file"
                            accept="image/*"
                            style={s('display:none')}
                            onChange={(e) => {
                              setPhoto(e.target.files?.[0]);
                              e.target.value = '';
                            }}
                          />
                        </label>
                      </Perm>
                    )}
                  </div>
                </div>
                <div className="field">
                  <label className="fl">
                    Batch Output
                    {r.type === 'SUB' && (
                      <span style={s('color:var(--grn-dk)')}> {'–'} divides the cost to give price per unit</span>
                    )}
                  </label>
                  <div style={s('display:flex;gap:6px')}>
                    <Perm perm="recipe.edit">
                      <CommitInput
                        className="cell"
                        type="number"
                        step="any"
                        style={s('text-align:right')}
                        value={r.batchOut || ''}
                        placeholder={`${cur(c.autoOut, 1)} (auto from ingredients)`}
                        onCommit={setBatchOut}
                      />
                    </Perm>
                    <Perm perm="recipe.edit">
                      <select
                        style={s('width:92px')}
                        value={c.bUom}
                        onChange={(e) => setBatchUom(e.target.value as 'Gram' | 'Ml' | 'Each')}
                      >
                        {['Gram', 'Ml', 'Each'].map((u) => (
                          <option key={u}>{u}</option>
                        ))}
                      </select>
                    </Perm>
                    <button
                      className="btn sm o"
                      onClick={autoBatchOut}
                      title="Set to the net weight of all ingredients"
                    >
                      Auto
                    </button>
                  </div>
                  <div style={s('font-size:11px;color:var(--mute);margin-top:4px')}>
                    {c.manualOut
                      ? `Entered by hand. Ingredients total ${cur(c.autoOut, 1)} ${c.autoUom} – the gap is cooking loss.`
                      : `Taken from the ingredient list: ${cur(c.autoOut, 1)} ${c.autoUom}. Type a figure to record cooking loss.`}
                  </div>
                </div>
                <div className="field">
                  <label className="fl">Portion Size</label>
                  <div
                    style={s(
                      'padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--org-xl);text-align:right;font-weight:700;color:var(--org-dk)',
                    )}
                  >
                    {cur(c.portion, batchDp)} {c.bUom}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="card" style={{ ...bv, borderTop: '3px solid var(--bc)' }}>
            <h3>Ingredients</h3>
            <div style={s('padding:0')}>
              <div className="tw" style={s('border:0;box-shadow:none;border-radius:0')}>
                <table>
                  <thead>
                    <tr>
                      <th style={s('width:150px')}>Code</th>
                      <th>Item</th>
                      <th className="c" style={s('width:70px')}>
                        UOM
                      </th>
                      <th className="n" style={s('width:90px')}>
                        Qty
                      </th>
                      <th className="c" style={s('width:86px')}>
                        Unit
                      </th>
                      <th className="n" style={s('width:80px')}>
                        Yield %
                      </th>
                      <th className="n" style={s('width:96px')}>
                        Unit Price
                      </th>
                      <th className="n" style={s('width:96px')}>
                        Line Cost
                      </th>
                      <th style={s('width:34px')}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <LineRow
                        key={i}
                        i={i}
                        l={l}
                        lv={d.view.lines[i]}
                        brandId={r.brandId}
                        buffer={r.buffer != null ? r.buffer : st.buffer}
                        onChange={(patch) => setLine(i, patch)}
                        onDelete={() => commitLines(linesRef.current.filter((_, j) => j !== i))}
                      />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={s('background:var(--org-lt);font-weight:700')}>
                      <td colSpan={3} style={s('padding:9px 10px')}>
                        BATCH TOTAL
                      </td>
                      <td className="n">{cur(d.view.sumQty, 2)}</td>
                      <td colSpan={3}></td>
                      <td className="n" style={s('color:var(--org-dk)')}>
                        {cur(c.batch, 3)}
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div
                style={s(
                  'padding:12px 16px;border-top:1px solid var(--bc-sf);background:var(--bc-wa);display:flex;align-items:center;gap:9px',
                )}
              >
                <Perm perm="recipe.edit">
                  <button
                    className="btn sm"
                    onClick={() =>
                      openBrowse(
                        modal,
                        r.brandId,
                        (code, unit) => {
                          const cur0 = linesRef.current;
                          const last = cur0[cur0.length - 1];
                          if (last && !last.code)
                            commitLines(cur0.map((l, j) => (j === cur0.length - 1 ? { ...l, code, unit, y: 1 } : l)));
                          else
                            commitLines([
                              ...cur0,
                              { code, qty: 0, unit, y: 1, yp: null, yThaw: null, yCut: null, yCook: null },
                            ]);
                        },
                        toast,
                      )
                    }
                  >
                    {'＋'} Search raw materials
                  </button>
                </Perm>
                <Perm perm="recipe.edit">
                  <button
                    className="btn sm o"
                    onClick={() =>
                      commitLines([
                        ...linesRef.current,
                        { code: '', qty: 0, unit: 'Gram', y: 1, yp: null, yThaw: null, yCut: null, yCook: null },
                      ])
                    }
                  >
                    Add blank row
                  </button>
                </Perm>
                <span style={s('font-size:11.5px;color:var(--mute)')}>
                  Or type a name straight into the Code box {'–'} arrow keys and Enter work.
                </span>
              </div>
            </div>
          </div>

          <div className="card" style={{ ...s('margin-top:18px'), ...bv, borderTop: '3px solid var(--bc)' }}>
            <h3>Cooking Method</h3>
            <div className="bd">
              {r.method.map((m, i) => (
                <div key={i} style={s('display:flex;gap:9px;margin-bottom:8px;align-items:center')}>
                  <span style={s('width:22px;text-align:center;color:var(--org);font-weight:700')}>{i + 1}</span>
                  <Perm perm="recipe.edit">
                    <CommitInput value={m} onCommit={(v) => setMethod(r.method.map((x, j) => (j === i ? v : x)))} />
                  </Perm>
                  <Perm perm="recipe.edit">
                    <button className="btn sm d" onClick={() => setMethod(r.method.filter((_, j) => j !== i))}>
                      {'×'}
                    </button>
                  </Perm>
                </div>
              ))}
              <Perm perm="recipe.edit">
                <button className="btn sm o" onClick={() => setMethod([...r.method, ''])}>
                  + Add step
                </button>
              </Perm>
            </div>
          </div>
        </div>

        <div style={s('position:sticky;top:88px')}>
          <div className="card" style={{ borderTop: `3px solid ${pal.base}`, ...bv }}>
            <div className="bd">
              <label className="fl">Sales Price (excl VAT)</label>
              <Perm perm="recipe.price">
                <CommitInput
                  className="cell"
                  type="number"
                  step="any"
                  style={s('font-size:19px;font-weight:700;text-align:right')}
                  value={r.sellingPrice || 0}
                  onCommit={setPrice}
                />
              </Perm>
              <div style={s('text-align:right;font-size:11px;color:var(--mute);margin-top:4px')}>
                incl VAT {cur(c.vatPrice)} {'·'} {st.currency}
              </div>

              <div style={s('margin-top:16px')}>
                <PRow k="Batch cost" v={cur(c.batch, 3)} />
                <PRow k="Batch output" v={`${cur(c.bOut, batchDp)} ${c.bUom}`} />
                <PRow k="Portions" v={String(c.out)} />
                <PRow k="Portion size" v={`${cur(c.portion, batchDp)} ${c.bUom}`} />
                <PRow k="Original cost / portion" v={cur(c.orig, 3)} />
                <PRow k="Variable buffer" v={cur(c.food - c.orig, 3)} note={'+' + pct(st.buffer)} />
                <PRow
                  k="FOOD COST"
                  v={<span style={s('color:var(--bc-tx,var(--org-dk))')}>{cur(c.food, 3)}</span>}
                  hd
                />
                <PRow k="Packaging" v={cur(c.pkg)} note={pct(st.pkg)} />
                <PRow k="Delivery" v={cur(c.del)} note={pct(st.del)} />
                <PRow k="Labor" v={cur(c.lab)} note={pct(st.lab)} />
                <PRow k="OPS" v={cur(c.ops)} note={pct(st.ops)} />
                <PRow k="TOTAL COST" v={cur(c.totalCost)} hd />
                <PRow
                  k="NET PROFIT"
                  v={
                    <span style={{ color: c.sp && c.net < 0 ? 'var(--bad)' : 'var(--grn-dk)' }}>
                      {c.sp ? cur(c.net) : '-'}
                    </span>
                  }
                  hd
                />
              </div>

              <div style={s('margin-top:16px;padding:13px;background:var(--org-xl);border-radius:9px')}>
                <div style={s('display:flex;justify-content:space-between;align-items:center;margin-bottom:8px')}>
                  <span
                    style={s(
                      'font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--bc-tx,var(--mute))',
                    )}
                  >
                    Food Cost
                  </span>
                  <span className={`pill ${fcClass(c.fcPct, st.target)}`} style={s('font-size:13px;padding:3px 11px')}>
                    {pct(c.fcPct)}
                  </span>
                </div>
                <div className="bar" style={s('height:9px')}>
                  <i
                    style={{
                      width: `${c.fcPct == null ? 0 : Math.min(100, (c.fcPct / Math.max(st.target * 2, 0.01)) * 100)}%`,
                      background:
                        c.fcPct == null
                          ? '#ccc'
                          : c.fcPct <= st.target
                            ? 'var(--grn)'
                            : c.fcPct <= st.target * 1.25
                              ? 'var(--warn)'
                              : 'var(--bad)',
                    }}
                  ></i>
                </div>
                <div
                  style={s(
                    'display:flex;justify-content:space-between;font-size:11px;color:var(--mute);margin-top:6px',
                  )}
                >
                  <span>target {pct(st.target)}</span>
                  <span>net {pct(c.npPct)}</span>
                </div>
                <div
                  style={s(
                    'margin-top:11px;padding-top:11px;border-top:1px dashed var(--bc-sf,#E0CDB8);display:flex;justify-content:space-between;font-size:12.5px',
                  )}
                >
                  <span style={s('color:var(--mute)')}>Price at target</span>
                  <b style={s('color:var(--org-dk)')}>{cur(c.suggest)}</b>
                </div>
                {c.sp > 0 && (
                  <Perm perm="recipe.price">
                    <button
                      className="btn sm o"
                      style={s('width:100%;margin-top:9px;justify-content:center')}
                      onClick={() => setPrice(c.suggest.toFixed(3))}
                    >
                      Apply suggested price
                    </button>
                  </Perm>
                )}
              </div>

              {r.type === 'SUB' && (
                <div className="note g" style={s('margin:14px 0 0')}>
                  Cost per {c.bUom}: <b>{cur(c.unitCost, 6)}</b>
                  <br />
                  Use code <b className="mono">{r.code || '(set a code)'}</b> in any other card.
                </div>
              )}
              {c.err && (
                <div className="note r" style={s('margin:14px 0 0')}>
                  Cost is incomplete: {c.err}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function PRow({ k, v, note, hd }: { k: string; v: React.ReactNode; note?: string; hd?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '6px 0',
        ...(hd ? { borderTop: '1px solid var(--line)', marginTop: 6, paddingTop: 10, fontWeight: 700 } : {}),
      }}
    >
      <span style={{ color: hd ? 'var(--ink)' : 'var(--mute)', fontSize: '12.5px' }}>
        {k}
        {note && <span style={s('color:var(--org);font-size:11px')}> {note}</span>}
      </span>
      <b style={{ fontVariantNumeric: 'tabular-nums' }}>{v}</b>
    </div>
  );
}
