'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Acts } from '@/components/shell/Shell';
import { api, errText } from '@/components/shared/api-client';
import { useModal } from '@/components/shared/Modal';
import { Perm } from '@/components/shared/Perm';
import { usePerm } from '@/components/shared/session-context';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { SEED_ISSUES, YIELD_REF } from '@/data';
import type { HealthRow, Severity } from '@/lib/screens/health';
import { useRouter } from 'next/navigation';
import type { AuditRow } from '@/lib/services/audit';
import { ROLES, isRole } from '@/lib/permissions';

/** Legacy vYields (4068). Reference only; not used by costing. */
export function YieldsScreen() {
  const [yq, setYq] = useState('');
  const list = YIELD_REF.filter((y) => !yq || `${y[0]} ${y[1]}`.toLowerCase().includes(yq.toLowerCase()));
  return (
    <>
      <div className="note">
        Reference only. Copy a figure into the Yield % column of a recipe line. A yield above 100% is correct for anything that
        absorbs water - 100 g of dry rice becomes about 270 g cooked.
      </div>
      <div style={s('max-width:360px;margin-bottom:14px')}>
        <input id="q_y" type="text" placeholder="Search..." value={yq} onChange={(e) => setYq(e.target.value)} />
      </div>
      <div className="tw">
        <table>
          <thead>
            <tr>
              <th style={s('width:150px')}>Category</th>
              <th>Item / Process</th>
              <th className="c" style={s('width:110px')}>
                Yield
              </th>
              <th>What the loss is</th>
            </tr>
          </thead>
          <tbody>
            {list.map((y, i) => (
              <tr key={i}>
                <td style={s('font-size:12px;color:var(--mute)')}>{y[0]}</td>
                <td>
                  <b>{y[1]}</b>
                </td>
                <td className="c">
                  <span className={`pill ${y[2] > 1 ? 'p-sub' : 'p-menu'}`}>{(y[2] * 100).toFixed(0)}%</span>
                </td>
                <td style={s('font-size:12px;color:var(--mute)')}>{y[3]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const sevClass = (x: string) => (x === 'CRITICAL' ? 'p-bad' : x === 'HIGH' ? 'p-warn' : 'p-gr');

/** Legacy vHealth (4318). */
export function HealthScreen({ live, flagged }: { live: HealthRow[]; flagged: number }) {
  const [tab, setTab] = useState<'live' | 'imp'>('live');
  const nC = live.filter((x) => x.sev === ('CRITICAL' as Severity)).length;
  return (
    <>
      <div className="kpis" style={s('grid-template-columns:repeat(auto-fit,minmax(150px,1fr))')}>
        <div className={`kpi ${nC ? 'r' : 'g'}`}>
          <div className="k">Live Problems</div>
          <div className="v">{live.length}</div>
          <div className="n">{nC} critical</div>
        </div>
        <div className="kpi w">
          <div className="k">Flagged On Import</div>
          <div className="v">{SEED_ISSUES.length}</div>
          <div className="n">from your original price list</div>
        </div>
        <div className="kpi">
          <div className="k">Ingredients Flagged</div>
          <div className="v">{flagged}</div>
          <div className="n">need a price or unit check</div>
        </div>
      </div>
      <div className="tabs">
        <button className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>
          Live Problems ({live.length})
        </button>
        <button className={tab !== 'live' ? 'on' : ''} onClick={() => setTab('imp')}>
          Import Findings ({SEED_ISSUES.length})
        </button>
      </div>
      {tab === 'live' ? (
        live.length ? (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th style={s('width:100px')}>Severity</th>
                  <th style={s('width:240px')}>Where</th>
                  <th>Problem</th>
                  <th>Why it matters</th>
                </tr>
              </thead>
              <tbody>
                {live.map((x, i) => (
                  <tr key={i}>
                    <td>
                      <span className={`pill ${sevClass(x.sev)}`}>{x.sev}</span>
                    </td>
                    <td>
                      <b>{x.where}</b>
                    </td>
                    <td>{x.problem}</td>
                    <td style={s('color:var(--mute);font-size:12px')}>{x.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="card">
            <div className="empty">
              <div className="big">{'✓'}</div>
              <p>No live problems. Every recipe line resolves to a real price.</p>
            </div>
          </div>
        )
      ) : (
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th style={s('width:100px')}>Severity</th>
                <th style={s('width:220px')}>Item / Area</th>
                <th>What is wrong</th>
                <th>Suggested fix</th>
              </tr>
            </thead>
            <tbody>
              {SEED_ISSUES.map((x, i) => (
                <tr key={i}>
                  <td>
                    <span className={`pill ${sevClass(x[0]!)}`}>{x[0]}</span>
                  </td>
                  <td>
                    <b>{x[1]}</b>
                  </td>
                  <td style={s('font-size:12.5px')}>{x[2]}</td>
                  <td style={s('color:var(--mute);font-size:12px')}>{x[3]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Legacy when(): "Today HH:MM" or locale date + time. */
function when(iso: string): string {
  const d = new Date(iso);
  const n = new Date();
  const same = d.toDateString() === n.toDateString();
  return (same ? 'Today' : d.toLocaleDateString()) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Legacy vAudit (954). Search runs on the server (the log has no cap now); D-31 archive marker + "show archived". */
export function AuditScreen({ initial }: { initial: { rows: AuditRow[]; total: number; archivedHidden: number } }) {
  const router = useRouter();
  const toast = useToast();
  const modal = useModal();
  const can = usePerm();
  const [aq, setAq] = useState('');
  const [archived, setArchived] = useState(false);
  const [data, setData] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        setData(await api('GET', `/api/audit?q=${encodeURIComponent(aq)}&archived=${archived ? 1 : 0}`));
      } catch (e) {
        toast(errText(e));
      }
    }, 200);
    return () => clearTimeout(timer.current);
  }, [aq, archived, toast]);
  useEffect(() => setData(initial), [initial]);

  async function exportCsv() {
    window.location.href = `/api/audit?format=csv&q=${encodeURIComponent(aq)}&archived=${archived ? 1 : 0}`;
    toast('Activity log downloaded');
  }
  function clear() {
    modal.open({
      title: 'Clear the activity log',
      body: (
        <p>
          This hides all {data.total} recorded entries from the log. They are kept in the database and can be shown again with Show
          archived. Export it first if you need the history.
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
                await api('POST', '/api/audit/archive');
                modal.close();
                toast('Log cleared');
                router.refresh();
              } catch (e) {
                toast(errText(e));
              }
            }}
          >
            Clear log
          </button>
        </>
      ),
    });
  }

  const pill = (a: string) => (/Delet|Reset|Restore/i.test(a) ? 'p-bad' : /Price|Setting/i.test(a) ? 'p-warn' : 'p-menu');
  const roleLabel = useMemo(() => (r: string) => (isRole(r) ? ROLES[r].label : r), []);

  return (
    <>
      <Acts>
        <button className="btn o" onClick={exportCsv}>
          Export CSV
        </button>
        <Perm perm="data.admin">
          <button className="btn d" onClick={clear}>
            Clear log
          </button>
        </Perm>
      </Acts>
      <div className="note">
        Every price change, card edit and deletion is recorded with the name of whoever was signed in. {data.total} entries held,
        newest first.
        {data.archivedHidden > 0 && (
          <>
            {' '}
            {data.archivedHidden} older entries are archived.
          </>
        )}
      </div>
      <div style={s('max-width:380px;margin-bottom:14px;display:flex;gap:12px;align-items:center')}>
        <input id="q_a" type="text" placeholder="Search the log..." value={aq} onChange={(e) => setAq(e.target.value)} />
        {can('data.admin') && (
          <label style={s('font-size:12px;white-space:nowrap;display:flex;gap:6px;align-items:center;cursor:pointer')}>
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived
          </label>
        )}
      </div>
      {data.rows.length ? (
        <div className="tw h">
          <table>
            <thead>
              <tr>
                <th style={s('width:150px')}>When</th>
                <th style={s('width:170px')}>Who</th>
                <th style={s('width:190px')}>Action</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((e) => (
                <tr key={e.id}>
                  <td style={s('font-size:12px;color:var(--mute);white-space:nowrap')} suppressHydrationWarning>
                    {when(e.at)}
                  </td>
                  <td>
                    <b>{e.user}</b>
                    <div style={s('font-size:11px;color:var(--mute)')}>{roleLabel(e.role)}</div>
                  </td>
                  <td>
                    <span className={`pill ${pill(e.action)}`}>{e.action}</span>
                  </td>
                  <td style={s('font-size:12.5px')}>{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card">
          <div className="empty">
            <div className="big">{'○'}</div>
            <p>Nothing logged yet.</p>
          </div>
        </div>
      )}
    </>
  );
}
