'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from '@/components/shell/nav-progress';
import { Acts } from '@/components/shell/Shell';
import { api, errText } from '@/components/shared/api-client';
import { createStore, useStore, type Store } from '@/components/shared/form-store';
import { useModal } from '@/components/shared/Modal';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { ROLES, ROLE_KEYS, isRole, type Role } from '@/lib/permissions';
import type { InviteRow, UserRow } from '@/lib/services/users';

const LEVELS: [string, string][] = [
  ['Create and edit recipe cards', 'recipe.edit'],
  ['Approve and lock a card', 'recipe.lock'],
  ['Reopen an approved card', 'recipe.unlock'],
  ['Set sales prices', 'recipe.price'],
  ['Delete recipe cards', 'recipe.delete'],
  ['Edit ingredient purchase prices', 'items.edit'],
  ['Edit unit conversions', 'conv.edit'],
  ['Edit menu plans', 'menu.edit'],
  ['Change global cost settings', 'settings.edit'],
  ['Manage brands', 'brands.edit'],
  ['Restore, import or reset data', 'data.admin'],
  ['Manage users', 'users.manage'],
  ['View the activity log', 'audit.view'],
  ['Print and export', 'export'],
];

interface InviteForm {
  email: string;
  role: Role;
  brandIds: string[];
  busy: boolean;
}
interface EditForm {
  role: Role | '';
  name: string;
  brandIds: string[];
  busy: boolean;
}

/**
 * Users & Access (D-31). New screen, built only from legacy primitives (.note, .tw, pills, modal). Roles live in Clerk
 * (publicMetadata.role); brand access lives in this database. Suspended = banned in Clerk and inactive here.
 */
export function UsersScreen({
  users,
  invites = [],
  invitesFailed = false,
  brands,
}: {
  users: UserRow[];
  invites?: InviteRow[];
  invitesFailed?: boolean;
  brands: { id: string; name: string; code: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const modal = useModal();
  const nOff = users.filter((u) => !u.active).length;
  const brandCode = new Map(brands.map((b) => [b.id, b.code]));

  const done = (msg: string) => {
    modal.close();
    toast(msg);
    router.refresh();
  };

  function invite() {
    const st = createStore<InviteForm>({ email: '', role: 'viewer', brandIds: [], busy: false });
    async function send() {
      const f = st.get();
      if (!f.email.trim()) return toast('Enter an email address');
      st.set({ busy: true });
      try {
        await api('POST', '/api/users/invite', {
          email: f.email.trim(),
          role: f.role,
          ...(f.role === 'gm' ? {} : { brandIds: f.brandIds }),
        });
        done(`Invitation sent to ${f.email.trim()}`);
      } catch (e) {
        st.set({ busy: false });
        toast(errText(e));
      }
    }
    modal.open({
      title: 'Invite user',
      body: <InviteBody st={st} brands={brands} />,
      foot: (
        <>
          <button className="btn o" onClick={modal.close}>
            Cancel
          </button>
          <button className="btn" onClick={send}>
            Send invitation
          </button>
        </>
      ),
    });
  }

  function edit(u: UserRow) {
    const st = createStore<EditForm>({ role: u.role ?? '', name: u.name, brandIds: u.brandIds, busy: false });
    async function save() {
      const f = st.get();
      st.set({ busy: true });
      try {
        await api('PATCH', `/api/users/${u.id}`, {
          ...(f.role && f.role !== u.role ? { role: f.role } : {}),
          ...(f.name.trim() && f.name.trim() !== u.name ? { name: f.name.trim() } : {}),
          brandIds: f.role === 'gm' ? [] : f.brandIds,
        });
        done('User updated');
      } catch (e) {
        st.set({ busy: false });
        toast(errText(e));
      }
    }
    modal.open({
      title: 'Edit user',
      body: <EditBody st={st} u={u} brands={brands} />,
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

  function editInvite(i: InviteRow) {
    const st = createStore<EditForm>({ role: i.role ?? '', name: '', brandIds: i.brandIds, busy: false });
    async function save() {
      const f = st.get();
      if (f.busy) return;
      st.set({ busy: true });
      try {
        await api('PATCH', `/api/users/invites/${encodeURIComponent(i.id)}`, {
          ...(f.role && f.role !== i.role ? { role: f.role } : {}),
          brandIds: f.role === 'gm' ? [] : f.brandIds,
        });
        done('Invitation updated');
      } catch (e) {
        st.set({ busy: false });
        toast(errText(e));
        router.refresh();
      }
    }
    modal.open({
      title: 'Edit access',
      body: <EditBody st={st} u={null} email={i.email} currentRole={i.role} brands={brands} />,
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

  function revoke(i: InviteRow) {
    modal.open({
      title: 'Revoke this invitation?',
      body: (
        <p style={s('font-size:13.5px')}>
          <b>{i.email}</b> will no longer be able to join with this invitation. You can invite them again later.
        </p>
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
                await api('DELETE', `/api/users/invites/${encodeURIComponent(i.id)}`);
                done('Invitation revoked');
              } catch (e) {
                toast(errText(e));
                router.refresh();
              }
            }}
          >
            Revoke
          </button>
        </>
      ),
    });
  }

  function toggle(u: UserRow) {
    const suspend = u.active;
    modal.open({
      title: suspend ? 'Suspend this user?' : 'Restore this user?',
      body: (
        <p style={s('font-size:13.5px')}>
          <b>{u.name}</b>
          {suspend
            ? ' will no longer be able to sign in. Their history stays in the activity log.'
            : ' will be able to sign in again.'}
        </p>
      ),
      foot: (
        <>
          <button className="btn o" onClick={modal.close}>
            Cancel
          </button>
          <button
            className={`btn ${suspend ? 'd' : 'g'}`}
            onClick={async () => {
              try {
                await api('POST', `/api/users/${u.id}/${suspend ? 'ban' : 'unban'}`);
                done(suspend ? 'User suspended' : 'User restored');
              } catch (e) {
                toast(errText(e));
              }
            }}
          >
            {suspend ? 'Suspend' : 'Restore'}
          </button>
        </>
      ),
    });
  }

  function remove(u: UserRow) {
    modal.open({
      title: 'Delete this user?',
      body: (
        <>
          <p style={s('font-size:13.5px')}>
            <b>{u.name}</b> {u.email && `(${u.email})`}
          </p>
          <div className="note r" style={s('margin-top:12px')}>
            Their sign-in is removed. Entries they made in the activity log are kept with their name.
          </div>
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
                await api('DELETE', `/api/users/${u.id}`);
                done('User deleted');
              } catch (e) {
                toast(errText(e));
              }
            }}
          >
            Delete
          </button>
        </>
      ),
    });
  }

  return (
    <>
      <Acts>
        <button className="btn" onClick={invite}>
          + Invite User
        </button>
      </Acts>
      {nOff > 0 && (
        <div className="note" style={s('margin-bottom:10px')}>
          {nOff} account{nOff === 1 ? ' is' : 's are'} suspended {'–'} kept for the record but unable to sign in.{' '}
          {users.length - nOff} can sign in.
        </div>
      )}
      {invites.length > 0 && (
        <div className="note" style={s('margin-bottom:10px')}>
          {invites.length} invitation{invites.length === 1 ? '' : 's'} pending.
        </div>
      )}
      {invitesFailed && (
        <div className="note r" style={s('margin-bottom:10px')}>
          Pending invitations could not be loaded just now. Reload the page to try again.
        </div>
      )}
      <div className="note r">
        <b>Understand what this is.</b> Each person signs in as themselves. Access levels stop the wrong person changing
        a purchase price or deleting a card by accident, and every action is recorded with their name. A person with no
        access level yet sees &ldquo;Account pending&rdquo; until you give them one.
      </div>
      <div className="tw" style={s('margin-bottom:22px')}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Access Level</th>
              <th className="c" style={s('width:104px')}>
                Availability
              </th>
              <th>Brands</th>
              <th>What they can do</th>
              <th className="c" style={s('width:250px')}>
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const R = u.role && isRole(u.role) ? ROLES[u.role] : null;
              return (
                <tr key={u.id} style={u.active ? undefined : s('background:var(--org-xl)')}>
                  <td>
                    <b style={u.active ? undefined : s('color:var(--mute)')}>{u.name}</b>
                    {u.isYou && (
                      <>
                        {' '}
                        <span className="pill p-ok">you</span>
                      </>
                    )}
                    <div style={s('font-size:11px;color:var(--mute)')}>{u.email}</div>
                  </td>
                  <td>
                    {R ? (
                      <span className="pill" style={{ background: u.active ? R.colour : '#CFC5BB', color: '#fff' }}>
                        {R.label}
                      </span>
                    ) : (
                      <span className="pill p-warn">no role yet</span>
                    )}
                  </td>
                  <td className="c">
                    {u.active ? (
                      <span className="pill p-ok">available</span>
                    ) : (
                      <span className="pill p-gr">suspended</span>
                    )}
                  </td>
                  <td style={s('font-size:12px')}>
                    {u.role === 'gm' ? (
                      <span className="pill p-gr">all brands</span>
                    ) : u.brandIds.length ? (
                      u.brandIds.map((id, k) => (
                        <span key={id}>
                          {k > 0 && ' '}
                          <span className="pill p-sub">{brandCode.get(id) ?? '?'}</span>
                        </span>
                      ))
                    ) : (
                      <span style={s('color:var(--mute)')}>none</span>
                    )}
                  </td>
                  <td style={s('font-size:12px;color:var(--mute)')}>{R?.note ?? 'Waiting for an access level.'}</td>
                  <td className="c" style={s('white-space:nowrap')}>
                    <button className="btn sm o" onClick={() => edit(u)}>
                      Edit
                    </button>{' '}
                    {!u.isYou && (
                      <>
                        <button className={`btn sm ${u.active ? '' : 'g'}`} onClick={() => toggle(u)}>
                          {u.active ? 'Suspend' : 'Restore'}
                        </button>{' '}
                        <button className="btn sm d" onClick={() => remove(u)}>
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {invites.map((i) => {
              const R = i.role && isRole(i.role) ? ROLES[i.role] : null;
              return (
                <tr key={i.id}>
                  <td>
                    <b>{i.email}</b>
                    <div style={s('font-size:11px;color:var(--mute)')}>Invited</div>
                  </td>
                  <td>
                    {R ? (
                      <span className="pill" style={{ background: R.colour, color: '#fff' }}>
                        {R.label}
                      </span>
                    ) : (
                      <span className="pill p-warn">no role yet</span>
                    )}
                  </td>
                  <td className="c">
                    <span className="pill p-warn">pending</span>
                  </td>
                  <td style={s('font-size:12px')}>
                    {i.role === 'gm' ? (
                      <span className="pill p-gr">all brands</span>
                    ) : i.brandIds.length ? (
                      i.brandIds.map((id, k) => (
                        <span key={id}>
                          {k > 0 && ' '}
                          <span className="pill p-sub">{brandCode.get(id) ?? '?'}</span>
                        </span>
                      ))
                    ) : (
                      <span style={s('color:var(--mute)')}>none</span>
                    )}
                  </td>
                  <td style={s('font-size:12px;color:var(--mute)')}>{R?.note ?? 'Waiting for an access level.'}</td>
                  <td className="c" style={s('white-space:nowrap')}>
                    <button className="btn sm o" onClick={() => editInvite(i)}>
                      Edit access
                    </button>{' '}
                    <button className="btn sm d" onClick={() => revoke(i)}>
                      Revoke invite
                    </button>
                  </td>
                </tr>
              );
            })}
            {users.length === 0 && invites.length === 0 && (
              <tr>
                <td colSpan={6} style={s('color:var(--mute)')}>
                  No users yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 style={s('margin:0 0 12px;font-size:13px;letter-spacing:.05em;text-transform:uppercase;color:var(--org-dk)')}>
        What each level unlocks
      </h3>
      <div className="tw">
        <table>
          <thead>
            <tr>
              <th>Action</th>
              {ROLE_KEYS.map((k) => (
                <th key={k} className="c">
                  {ROLES[k].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LEVELS.map(([lbl, p]) => (
              <tr key={p}>
                <td>{lbl}</td>
                {ROLE_KEYS.map((k) => {
                  const perms = ROLES[k].perms as readonly string[];
                  const ok = perms.includes('*') || perms.includes(p);
                  return (
                    <td key={k} className="c">
                      {ok ? (
                        <span style={s('color:var(--grn-dk);font-weight:700')}>{'✓'}</span>
                      ) : (
                        <span style={s('color:#D8CCC2')}>{'—'}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function InviteBody({ st, brands }: { st: Store<InviteForm>; brands: { id: string; name: string; code: string }[] }) {
  const f = useStore(st);
  return (
    <>
      <div className="field">
        <label className="fl">Email address</label>
        <input
          type="text"
          className="cell"
          value={f.email}
          autoFocus
          placeholder="name@company.com"
          onChange={(e) => st.set({ email: e.target.value })}
        />
      </div>
      <div className="field">
        <label className="fl">Access level</label>
        <select value={f.role} onChange={(e) => st.set({ role: e.target.value as Role })}>
          {ROLE_KEYS.map((k) => (
            <option key={k} value={k}>
              {ROLES[k].label}
            </option>
          ))}
        </select>
      </div>
      <div className="note" style={s('margin:0')}>
        {ROLES[f.role].note} They receive an email invitation; after they sign up they land with this access level.
      </div>
      {f.role !== 'gm' && (
        <div style={s('margin-top:12px')}>
          <BrandPicker brandIds={f.brandIds} brands={brands} onChange={(brandIds) => st.set({ brandIds })} />
        </div>
      )}
    </>
  );
}

function EditBody({
  st,
  u,
  email,
  currentRole,
  brands,
}: {
  st: Store<EditForm>;
  u: UserRow | null; // null = a pending invitation: no name, no self-protection
  email?: string;
  currentRole?: Role | null;
  brands: { id: string; name: string; code: string }[];
}) {
  const f = useStore(st);
  const had = u ? u.role : (currentRole ?? null);
  return (
    <>
      {u ? (
        <div className="field">
          <label className="fl">Name</label>
          <input type="text" className="cell" value={f.name} onChange={(e) => st.set({ name: e.target.value })} />
        </div>
      ) : (
        <p style={s('font-size:13.5px;margin:0 0 12px')}>
          <b>{email}</b>
        </p>
      )}
      <div className="field">
        <label className="fl">Access level</label>
        <select value={f.role} disabled={!!u?.isYou} onChange={(e) => st.set({ role: e.target.value as Role })}>
          {!had && <option value="">No access level yet</option>}
          {ROLE_KEYS.map((k) => (
            <option key={k} value={k}>
              {ROLES[k].label}
            </option>
          ))}
        </select>
        {u?.isYou && (
          <div style={s('font-size:11px;color:var(--mute);margin-top:4px')}>
            You cannot change your own access level.
          </div>
        )}
        {!u && f.role && f.role !== had && (
          <div style={s('font-size:11px;color:var(--mute);margin-top:4px')}>
            Changing the access level sends them a new invitation email.
          </div>
        )}
      </div>
      {f.role === 'gm' ? (
        <div className="note" style={s('margin:0')}>
          A General Manager sees every brand.
        </div>
      ) : (
        <BrandPicker brandIds={f.brandIds} brands={brands} onChange={(brandIds) => st.set({ brandIds })} />
      )}
    </>
  );
}

/** Brand checkboxes with a "Select all brands" convenience (D-81): it only ticks the boxes, is never pre-ticked and never grants GM. */
function BrandPicker({
  brandIds,
  brands,
  onChange,
}: {
  brandIds: string[];
  brands: { id: string; name: string; code: string }[];
  onChange: (ids: string[]) => void;
}) {
  const all = brands.length > 0 && brands.every((b) => brandIds.includes(b.id));
  const some = brandIds.length > 0 && !all;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some;
  }, [some]);
  return (
    <div className="field">
      <label className="fl" id="brand-picker-label">
        Brands this person can work in
      </label>
      <label style={s('display:flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer;margin-bottom:6px')}>
        <input
          ref={ref}
          type="checkbox"
          checked={all}
          onChange={(e) => onChange(e.target.checked ? brands.map((b) => b.id) : [])}
        />
        <b>Select all brands</b>
      </label>
      <div
        role="group"
        aria-labelledby="brand-picker-label"
        style={s(
          'display:grid;grid-template-columns:1fr 1fr;gap:5px;border:1px solid var(--line);border-radius:7px;padding:9px',
        )}
      >
        {brands.map((b) => (
          <label key={b.id} style={s('display:flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer')}>
            <input
              type="checkbox"
              checked={brandIds.includes(b.id)}
              onChange={(e) => onChange(e.target.checked ? [...brandIds, b.id] : brandIds.filter((x) => x !== b.id))}
            />
            {b.name}
          </label>
        ))}
      </div>
      <div style={s('font-size:11px;color:var(--mute);margin-top:4px')}>
        A person with no brand sees no recipes, production or menus.
      </div>
    </div>
  );
}
