'use client';

import { useState } from 'react';
import { useRouter } from '@/components/shell/nav-progress';
import { api, errText } from '@/components/shared/api-client';
import { CommitInput } from '@/components/shared/inputs';
import { Perm } from '@/components/shared/Perm';
import { usePerm } from '@/components/shared/session-context';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';

export interface SettingsClient {
  id: string;
  brandId: string;
  brandName: string;
  name: string;
  active: boolean;
  version: number;
}

/** Clients of each brand (D-68/D-71). A rename follows everywhere (rows hold the id); a client with production rows can only be deactivated. */
export function ClientsCard({
  clients,
  brands,
}: {
  clients: SettingsClient[];
  brands: { id: string; name: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const can = usePerm();
  const [brandId, setBrandId] = useState(brands[0]?.id ?? '');
  const [name, setName] = useState('');
  const [bump, setBump] = useState(0); // remounts the name fields to drop an edit that was not sent

  async function run(fn: () => Promise<unknown>, done?: string) {
    try {
      await fn();
      if (done) toast(done);
      router.refresh();
    } catch (e) {
      toast(errText(e));
    }
  }
  const patch = (c: SettingsClient, p: { name?: string; active?: boolean }, done?: string) =>
    run(() => api('PATCH', `/api/clients/${c.id}`, { ...p, version: c.version }), done);

  return (
    <div className="card" style={s('margin-top:18px;max-width:900px')}>
      <h3>Clients</h3>
      <div className="bd">
        <p style={s('font-size:13px;color:var(--mute);margin-bottom:14px')}>
          Clients belong to a brand. Production can be entered per client, and the Dashboard can be filtered by client.
        </p>
        {clients.length > 0 && (
          <div className="tw" style={s('box-shadow:none;margin-bottom:14px')}>
            <table>
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Brand</th>
                  <th className="c" style={s('width:90px')}>
                    Status
                  </th>
                  <th className="c" style={s('width:250px')}></th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {can('clients.edit') ? (
                        <CommitInput
                          key={`${c.id}:${c.version}:${bump}`}
                          className="cell"
                          value={c.name}
                          style={s('width:100%')}
                          onCommit={(v) => {
                            const t = v.trim();
                            if (!t) toast('A client needs a name');
                            if (!t || t === c.name) return setBump((n) => n + 1); // nothing to send: put the field back
                            return patch(c, { name: t }, 'Client renamed');
                          }}
                        />
                      ) : (
                        <b>{c.name}</b>
                      )}
                    </td>
                    <td>{c.brandName}</td>
                    <td className="c">
                      <span className={`pill ${c.active ? 'p-ok' : 'p-gr'}`}>{c.active ? 'Active' : 'Inactive'}</span>
                    </td>
                    <td className="c">
                      <Perm perm="clients.edit">
                        <button
                          className="btn sm o"
                          onClick={() =>
                            patch(c, { active: !c.active }, c.active ? 'Client deactivated' : 'Client reactivated')
                          }
                        >
                          {c.active ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </Perm>{' '}
                      <Perm perm="clients.edit">
                        <button
                          className="btn sm d"
                          onClick={() => run(() => api('DELETE', `/api/clients/${c.id}`), 'Client removed')}
                        >
                          Remove
                        </button>
                      </Perm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {clients.length === 0 && <div className="note">No clients yet.</div>}
        {can('clients.edit') && brands.length > 0 && (
          <div style={s('display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:12px')}>
            <select value={brandId} onChange={(e) => setBrandId(e.target.value)} style={s('max-width:230px')}>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={name}
              maxLength={80}
              placeholder="Client name"
              onChange={(e) => setName(e.target.value)}
              style={s('width:220px')}
            />
            <button
              className="btn"
              disabled={!name.trim() || !brandId}
              onClick={() =>
                run(async () => {
                  await api('POST', `/api/brands/${brandId}/clients`, { name: name.trim() });
                  setName('');
                }, 'Client added')
              }
            >
              Add client
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
