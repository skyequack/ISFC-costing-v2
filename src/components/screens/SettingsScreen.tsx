'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, ClientApiError, errText, uploadImage } from '@/components/shared/api-client';
import { createStore, useStore, type Store } from '@/components/shared/form-store';
import { imgError, readLogo, type PreparedImage } from '@/components/shared/images';
import { CommitInput } from '@/components/shared/inputs';
import { useModal } from '@/components/shared/Modal';
import { Perm } from '@/components/shared/Perm';
import { usePerm } from '@/components/shared/session-context';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { cur, fcClass, pct } from '@/lib/format';
import { ROLES, ROLE_KEYS } from '@/lib/permissions';
import type { SettingsDto } from '@/lib/db/repo/settings';
import type { RecipeRow } from '@/lib/screens/rows';

export interface SettingsBrand {
  id: string;
  code: string;
  name: string;
  color: string;
  logoUrl: string | null;
  locations: string[];
  cards: number;
  locked: number;
}

interface LogoPick {
  blob: Blob | null;
  preview: string | null;
  /** true when the user asked to remove the stored logo */
  remove: boolean;
}

/** Legacy vSettings (4085) + brand management (D-48 add-with-logo, D-52 sites editor). */
export function SettingsScreen({
  settings,
  brands,
  impact,
}: {
  settings: SettingsDto;
  brands: SettingsBrand[];
  impact: (RecipeRow & { brandName: string })[];
}) {
  const router = useRouter();
  const toast = useToast();
  const modal = useModal();
  const can = usePerm();
  const [st, setSt] = useState(settings);
  useEffect(() => setSt(settings), [settings]);
  const fixed = st.pkg + st.del + st.lab + st.ops;

  async function patch(p: Record<string, unknown>) {
    try {
      const r = await api<{ settings: SettingsDto; cards: number }>('PATCH', '/api/settings', {
        version: st.version,
        ...p,
      });
      setSt(r.settings);
      router.refresh();
    } catch (e) {
      toast(errText(e));
      router.refresh();
    }
  }
  const setPct = (k: 'pkg' | 'del' | 'lab' | 'ops' | 'buffer' | 'target' | 'vat', v: string) => {
    const n = parseFloat(v);
    if (!isFinite(n)) return toast('Enter a number');
    void patch({ [k]: n / 100 });
  };

  const pf = (k: 'pkg' | 'del' | 'lab' | 'ops' | 'buffer' | 'target' | 'vat', l: string, note?: string) => (
    <div className="field" key={k}>
      <label className="fl">{l}</label>
      <div style={s('display:flex;align-items:center;gap:8px')}>
        <Perm perm="settings.edit">
          <CommitInput
            className="cell"
            type="number"
            step="0.01"
            style={s('text-align:right')}
            value={(st[k] * 100).toFixed(2)}
            onCommit={(v) => setPct(k, v)}
          />
        </Perm>
        <span style={s('color:var(--mute)')}>%</span>
      </div>
      {note && <div style={s('font-size:11px;color:var(--mute);margin-top:4px')}>{note}</div>}
    </div>
  );

  // ---------------------------------------------------------------- brands
  const addPick = useRef<Store<{ name: string; code: string; logo: LogoPick; busy: boolean }>>(
    createStore({ name: '', code: '', logo: { blob: null, preview: null, remove: false }, busy: false }),
  );

  return (
    <>
      {!can('settings.edit') && (
        <div className="rolebar">
          <b>Read only.</b> Only a General Manager can change the cost structure or pricing policy. These figures drive
          every card in the system.
        </div>
      )}
      <div className="row r2" style={s('max-width:900px;align-items:start')}>
        <div className="card">
          <h3>Cost Structure</h3>
          <div className="bd">
            {pf('pkg', 'Packaging cost', '% of sales price')}
            {pf('del', 'Delivery cost', '% of sales price')}
            {pf('lab', 'Labor cost', '% of sales price')}
            {pf('ops', 'OPS cost', '% of sales price')}
            <div className={`note ${fixed >= 0.5 ? 'r' : ''}`} style={s('margin:6px 0 0')}>
              Fixed charges total <b>{pct(fixed)}</b> of every sale before a single ingredient. Food cost must stay
              under {pct(1 - fixed)} just to break even.
            </div>
          </div>
        </div>
        <div className="card">
          <h3>Pricing Policy</h3>
          <div className="bd">
            {pf('buffer', 'Variable cost buffer', 'added on top of raw ingredient cost')}
            {pf('target', 'Target food cost', 'drives the suggested price')}
            {pf('vat', 'VAT rate', 'grosses up the sales price')}
            <div className="field">
              <label className="fl">Currency code</label>
              <Perm perm="settings.edit">
                <CommitInput
                  className="cell"
                  value={st.currency}
                  onCommit={(v) => void patch({ currency: v.trim() })}
                />
              </Perm>
            </div>
            <div className="field">
              <label className="fl">Price list effective date</label>
              <Perm perm="settings.edit">
                <CommitInput
                  className="cell"
                  value={st.priceDate}
                  onCommit={(v) =>
                    /^\d{4}-\d{2}-\d{2}$/.test(v.trim())
                      ? void patch({ priceDate: v.trim() })
                      : toast('Use the form YYYY-MM-DD')
                  }
                />
              </Perm>
            </div>
          </div>
        </div>
      </div>

      <div className="card" style={s('margin-top:18px;max-width:900px')}>
        <h3>Brands &amp; Code Prefixes</h3>
        <div className="bd">
          <p style={s('font-size:13px;color:var(--mute);margin-bottom:14px')}>
            Each brand is a workspace. Its code prefix drives recipe numbering, so a Gourmet main course becomes{' '}
            <span className="mono">GRM-MN-0001</span>. Keep prefixes short and unique.
          </p>
          <div className="tw" style={s('box-shadow:none;margin-bottom:14px')}>
            <table>
              <thead>
                <tr>
                  <th style={s('width:88px')}>Logo</th>
                  <th style={s('width:80px')}>Prefix</th>
                  <th>Brand</th>
                  <th className="c" style={s('width:80px')}>
                    Cards
                  </th>
                  <th className="c" style={s('width:80px')}>
                    Locked
                  </th>
                  <th className="c" style={s('width:150px')}></th>
                </tr>
              </thead>
              <tbody>
                {brands.map((b) => (
                  <tr key={b.id}>
                    <td>
                      {b.logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={b.logoUrl}
                          alt=""
                          style={s('height:30px;max-width:74px;object-fit:contain;display:block')}
                        />
                      ) : (
                        <span style={s('color:var(--mute);font-size:11px')}>none</span>
                      )}
                    </td>
                    <td className="mono" style={{ fontWeight: 700, color: b.color || 'var(--org-dk)' }}>
                      {b.code}
                    </td>
                    <td>
                      <b>{b.name}</b>
                      {b.color && (
                        <span
                          style={{
                            display: 'inline-block',
                            width: 11,
                            height: 11,
                            borderRadius: 3,
                            background: b.color,
                            marginLeft: 7,
                            verticalAlign: 'middle',
                          }}
                        ></span>
                      )}
                    </td>
                    <td className="c">{b.cards}</td>
                    <td className="c">{b.locked}</td>
                    <td className="c">
                      <Perm perm="brands.edit">
                        <button className="btn sm o" onClick={() => editBrand(b)}>
                          Edit
                        </button>
                      </Perm>{' '}
                      <Perm perm="brands.edit">
                        <button className="btn sm d" onClick={() => delBrand(b)}>
                          Remove
                        </button>
                      </Perm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {can('brands.edit') && <AddBrand st={addPick.current} onAdd={addBrand} />}
        </div>
      </div>

      <div className="card" style={s('margin-top:18px;max-width:900px')}>
        <h3>Approval &amp; Access</h3>
        <div className="bd">
          <p style={s('font-size:13px;color:var(--mute);margin-bottom:12px')}>
            Who may approve a card, reopen an approved one, change a price or delete anything is decided by access
            level, not by a shared PIN. Each person signs in as themselves and every action is logged.
          </p>
          <div className="tw" style={s('box-shadow:none;margin-bottom:14px')}>
            <table>
              <thead>
                <tr>
                  <th style={s('width:170px')}>Access level</th>
                  <th className="c" style={s('width:80px')}>
                    Approve
                  </th>
                  <th className="c" style={s('width:80px')}>
                    Reopen
                  </th>
                  <th className="c" style={s('width:80px')}>
                    Price
                  </th>
                  <th className="c" style={s('width:80px')}>
                    Delete
                  </th>
                  <th>What it is for</th>
                </tr>
              </thead>
              <tbody>
                {[...ROLE_KEYS]
                  .sort((x, y) => ROLES[y].rank - ROLES[x].rank)
                  .map((k) => {
                    const R = ROLES[k];
                    const has = (p: string) =>
                      (R.perms as readonly string[]).includes('*') || (R.perms as readonly string[]).includes(p);
                    const tick = (b: boolean) =>
                      b ? <span className="pill p-ok">yes</span> : <span className="pill p-gr">no</span>;
                    return (
                      <tr key={k}>
                        <td>
                          <b style={{ color: R.colour }}>{R.label}</b>
                        </td>
                        <td className="c">{tick(has('recipe.lock'))}</td>
                        <td className="c">{tick(has('recipe.unlock'))}</td>
                        <td className="c">{tick(has('recipe.price'))}</td>
                        <td className="c">{tick(has('recipe.delete'))}</td>
                        <td style={s('font-size:12px;color:var(--mute)')}>{R.note}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          {can('users.manage') ? (
            <button className="btn" onClick={() => router.push('/users')}>
              Manage users and PINs
            </button>
          ) : (
            <div className="note" style={s('margin:0')}>
              Only a General Manager can add users or change PINs.
            </div>
          )}
        </div>
      </div>

      <div className="card" style={s('margin-top:18px;max-width:900px')}>
        <h3>Impact Preview</h3>
        <div className="bd">
          <div className="tw" style={s('box-shadow:none')}>
            <table>
              <thead>
                <tr>
                  <th>Recipe</th>
                  <th>Brand</th>
                  <th className="n">Food Cost</th>
                  <th className="n">Total Cost</th>
                  <th className="n">Price</th>
                  <th className="c">FC %</th>
                  <th className="n">Net</th>
                </tr>
              </thead>
              <tbody>
                {impact.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>
                      {r.brandName ? (
                        <span className="pill p-sub">{r.brandName}</span>
                      ) : (
                        <span style={s('color:var(--mute)')}>{'—'}</span>
                      )}
                    </td>
                    <td className="n">{cur(r.c.food)}</td>
                    <td className="n">{cur(r.c.totalCost)}</td>
                    <td className="n">{cur(r.c.sp)}</td>
                    <td className="c">
                      <span className={`pill ${fcClass(r.c.fcPct, st.target)}`}>{pct(r.c.fcPct)}</span>
                    </td>
                    <td className="n" style={{ color: r.c.sp && r.c.net < 0 ? 'var(--bad)' : undefined }}>
                      {cur(r.c.net)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );

  // -------------------------------------------------------------------- brand actions
  async function addBrand() {
    const f = addPick.current.get();
    const name = f.name.trim();
    let code = f.code
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (!name) return toast('Type a brand name');
    if (!code) code = (name.replace(/[^A-Za-z]/g, '').toUpperCase() + 'XXX').slice(0, 3);
    addPick.current.set({ busy: true });
    try {
      const { id } = await api<{ id: string }>('POST', '/api/brands', { name, code });
      let note = '';
      if (f.logo.blob) {
        try {
          await uploadImage(`/api/brands/${id}/logo`, f.logo.blob);
        } catch (e) {
          note = ` - the logo was not added (${errText(e)}); add it from Edit brand`;
        }
      }
      addPick.current.set({ name: '', code: '', logo: { blob: null, preview: null, remove: false }, busy: false });
      toast(`Brand ${name} (${code}) added${note}`);
      router.refresh();
    } catch (e) {
      addPick.current.set({ busy: false });
      toast(errText(e));
    }
  }

  function delBrand(b: SettingsBrand) {
    if (b.cards)
      return toast(`${b.cards} card${b.cards === 1 ? ' is' : 's are'} in ${b.name} – move or delete them first`);
    api('DELETE', `/api/brands/${b.id}`)
      .then(() => {
        toast('Brand removed');
        router.refresh();
      })
      .catch((e) => toast(errText(e)));
  }

  function editBrand(b: SettingsBrand) {
    const form = createStore({
      code: b.code,
      name: b.name,
      color: b.color || '#BB5E1E',
      logo: { blob: null, preview: b.logoUrl, remove: false } as LogoPick,
      hadLogo: !!b.logoUrl,
      sites: [...b.locations],
      renames: [] as { from: string; to: string }[],
      newSite: '',
      busy: false,
    });
    async function save() {
      const f = form.get();
      const name = f.name.trim();
      const code = f.code
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
      if (!name || !code) return toast('Name and prefix are both required');
      form.set({ busy: true });
      try {
        const body: Record<string, unknown> = { name, code, color: f.color };
        if (can('brands.edit') && JSON.stringify(f.sites) !== JSON.stringify(b.locations)) {
          body.locations = f.sites;
          body.renamedSites = f.renames;
        }
        await api('PATCH', `/api/brands/${b.id}`, body);
        if (f.logo.blob) await uploadImage(`/api/brands/${b.id}/logo`, f.logo.blob);
        else if (f.logo.remove && f.hadLogo) await api('DELETE', `/api/brands/${b.id}/logo`);
        modal.close();
        toast('Brand updated');
        router.refresh();
      } catch (e) {
        form.set({ busy: false });
        toast(errText(e));
      }
    }
    modal.open({
      title: 'Edit brand',
      body: <EditBrandBody st={form} cards={b.cards} />,
      foot: (
        <>
          <button className="btn o" onClick={modal.close}>
            Cancel
          </button>
          <button className="btn" onClick={save}>
            Save brand
          </button>
        </>
      ),
    });
  }
}

/** Pick/clear a logo: preview now, upload on save (legacy `__ebLogo`). */
function LogoBox({ pick, onPick, help }: { pick: LogoPick; onPick: (p: LogoPick) => void; help: boolean }) {
  const toast = useToast();
  async function choose(file: File | undefined) {
    if (!file) return;
    try {
      const out: PreparedImage = await readLogo(file);
      onPick({ blob: out.blob, preview: URL.createObjectURL(out.blob), remove: false });
      toast('Logo loaded – press Save brand');
    } catch (e) {
      toast(e instanceof ClientApiError ? e.message : imgError(e, 'That image could not be used'));
    }
  }
  return (
    <div className="logobox">
      <div className="logoprev" id="eb_prev">
        {pick.preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={pick.preview} alt="" />
        ) : (
          <span>No logo</span>
        )}
      </div>
      <div style={s('flex:1')}>
        <label className="btn sm o" style={s('justify-content:center')}>
          Choose image
          <input
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            style={s('display:none')}
            onChange={(e) => {
              void choose(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
        <button
          className="btn sm d"
          style={s('margin-top:7px;width:100%;justify-content:center')}
          onClick={() => onPick({ blob: null, preview: null, remove: true })}
        >
          Remove logo
        </button>
        {help && (
          <div style={s('font-size:10.5px;color:var(--mute);margin-top:7px')}>
            PNG with a transparent background works best. Resized to 320 px wide and stored inside this file, so keep it
            small.
          </div>
        )}
      </div>
    </div>
  );
}

/** Legacy add-brand row (name + prefix + Add) with the D-48(b) logo box. */
function AddBrand({
  st,
  onAdd,
}: {
  st: Store<{ name: string; code: string; logo: LogoPick; busy: boolean }>;
  onAdd: () => void;
}) {
  const f = useStore(st);
  return (
    <>
      <div className="row" style={s('grid-template-columns:110px 1fr 90px;max-width:470px')}>
        <input
          id="s_nc"
          type="text"
          placeholder="PREFIX"
          maxLength={4}
          style={s('text-transform:uppercase')}
          value={f.code}
          onChange={(e) => st.set({ code: e.target.value })}
        />
        <input
          id="s_nb"
          type="text"
          placeholder="Brand name"
          value={f.name}
          onChange={(e) => st.set({ name: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && onAdd()}
        />
        <button className="btn" disabled={f.busy} onClick={onAdd}>
          Add
        </button>
      </div>
      <div className="field" style={s('margin-top:12px;max-width:470px')}>
        <label className="fl">Brand logo</label>
        <LogoBox pick={f.logo} onPick={(logo) => st.set({ logo })} help />
      </div>
    </>
  );
}

function EditBrandBody({
  st,
  cards,
}: {
  st: Store<{
    code: string;
    name: string;
    color: string;
    logo: LogoPick;
    hadLogo: boolean;
    sites: string[];
    renames: { from: string; to: string }[];
    newSite: string;
    busy: boolean;
  }>;
  cards: number;
}) {
  const f = useStore(st);
  const can = usePerm();
  const toast = useToast();
  const orig = useRef(f.sites).current;

  function rename(i: number, to: string) {
    const t = to.trim();
    if (!t || t === f.sites[i]) return;
    if (t.includes('|')) return toast('A site name cannot contain |');
    if (f.sites.some((x, j) => j !== i && x.toLowerCase() === t.toLowerCase()))
      return toast('That site already exists');
    const from = f.sites[i]!;
    const origFrom = f.renames.find((r) => r.to === from)?.from ?? (orig.includes(from) ? from : null);
    const renames = f.renames.filter((r) => r.to !== from);
    if (origFrom) renames.push({ from: origFrom, to: t });
    st.set({ sites: f.sites.map((x, j) => (j === i ? t : x)), renames });
  }
  function addSite() {
    const t = f.newSite.trim();
    if (!t) return;
    if (t.includes('|')) return toast('A site name cannot contain |');
    if (f.sites.some((x) => x.toLowerCase() === t.toLowerCase())) return toast('That site already exists');
    st.set({ sites: [...f.sites, t], newSite: '' });
  }

  return (
    <>
      <div className="row" style={s('grid-template-columns:110px 1fr 96px')}>
        <div className="field">
          <label className="fl">Prefix</label>
          <input
            type="text"
            className="cell mono"
            maxLength={4}
            value={f.code}
            style={s('text-transform:uppercase')}
            onChange={(e) => st.set({ code: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="fl">Brand name</label>
          <input
            type="text"
            className="cell"
            value={f.name}
            autoFocus
            onChange={(e) => st.set({ name: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="fl">Colour</label>
          <input
            type="color"
            value={f.color}
            style={s('width:100%;height:36px;padding:2px;cursor:pointer')}
            onChange={(e) => st.set({ color: e.target.value })}
          />
        </div>
      </div>
      <div className="field">
        <label className="fl">Brand logo</label>
        <LogoBox pick={f.logo} onPick={(logo) => st.set({ logo })} help />
      </div>
      {can('brands.edit') && (
        <div className="field">
          <label className="fl">Sites</label>
          <div style={s('display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px')}>
            {f.sites.length === 0 && <span style={s('font-size:12px;color:var(--mute)')}>No sites</span>}
            {f.sites.map((x, i) => (
              <span
                key={x}
                className="pill p-sub"
                style={s('display:inline-flex;align-items:center;gap:6px;padding:3px 8px')}
              >
                <CommitInput
                  value={x}
                  onCommit={(v) => rename(i, v)}
                  style={s('width:90px;padding:2px 4px;font-size:11.5px')}
                />
                <button
                  type="button"
                  title="Remove site"
                  style={s('color:var(--bad);font-weight:700')}
                  onClick={() => st.set({ sites: f.sites.filter((_, j) => j !== i) })}
                >
                  {'×'}
                </button>
              </span>
            ))}
          </div>
          <div style={s('display:flex;gap:7px')}>
            <input
              type="text"
              placeholder="New site"
              value={f.newSite}
              onChange={(e) => st.set({ newSite: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && addSite()}
            />
            <button className="btn sm o" onClick={addSite}>
              Add
            </button>
          </div>
        </div>
      )}
      <div className="note" style={s('margin:0')}>
        {cards} card(s) belong to this brand. The logo and colour appear on every one of their recipe cards, on screen
        and in print.
      </div>
    </>
  );
}
