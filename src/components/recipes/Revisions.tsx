'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errText } from '@/components/shared/api-client';
import { useModal } from '@/components/shared/Modal';
import { Perm } from '@/components/shared/Perm';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { businessToday } from '@/lib/business-day';
import type { RevisionDetail, RevisionSummary } from '@/lib/services/revisions';

/**
 * D-100: the revisions of one card. The first row is the revision in force now; earlier ones are read-only. "Start new revision"
 * freezes the card as it is and starts the next one today, so it must be pressed BEFORE the changes (the text says so).
 */
export function RevisionsCard({
  id,
  revision,
  effectiveFrom,
  editable,
  getVersion,
  onStarted,
}: {
  id: string;
  revision: number;
  effectiveFrom: string;
  /** the editor passes true; the locked card is reopened (which starts a revision) instead */
  editable: boolean;
  /** the card's current edit version once pending saves have landed */
  getVersion: () => Promise<number>;
  onStarted: (r: { revision: number; effectiveFrom: string; version: number }) => void;
}) {
  const toast = useToast();
  const modal = useModal();
  const [list, setList] = useState<RevisionSummary[] | null>(null);
  const startedToday = effectiveFrom >= businessToday();

  useEffect(() => {
    let live = true;
    api<{ revisions: RevisionSummary[] }>('GET', `/api/recipes/${id}/revisions`)
      .then((r) => live && setList(r.revisions))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [id, revision]);

  const view = useCallback(
    async (n: number) => {
      try {
        const d = await api<RevisionDetail>('GET', `/api/recipes/${id}/revisions/${n}`);
        modal.open({
          title: `Revision ${d.revision} · ${d.effectiveFrom} to ${d.effectiveTo}`,
          body: (
            <>
              <p style={s('font-size:13px;color:var(--mute);margin-bottom:10px')}>
                {d.name} {'·'} {d.status === 'LOCKED' ? `approved by ${d.lockedBy || '–'}` : 'draft'} {'·'} read-only
              </p>
              <div className="tw" style={s('max-height:320px;overflow:auto')}>
                <table>
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th style={s('text-align:right')}>Qty</th>
                      <th>Unit</th>
                      <th style={s('text-align:right')}>Yield %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.lines
                      .filter((l) => l.code)
                      .map((l) => (
                        <tr key={l.sortOrder}>
                          <td className="mono">{l.code}</td>
                          <td style={s('text-align:right')}>{l.qty}</td>
                          <td>{l.unit}</td>
                          <td style={s('text-align:right')}>{Math.round(l.y * 100)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {d.method.some((m) => m.trim()) && (
                <ol style={s('margin:12px 0 0 20px;font-size:13px')}>
                  {d.method
                    .filter((m) => m.trim())
                    .map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                </ol>
              )}
            </>
          ),
        });
      } catch (e) {
        toast(errText(e));
      }
    },
    [id, modal, toast],
  );

  const start = () =>
    modal.open({
      title: 'Start new revision',
      body: (
        <p style={s('font-size:13.5px')}>
          Freezes this card as revision {revision} and starts revision {revision + 1} today. Do this before you change
          the card.
        </p>
      ),
      foot: (
        <>
          <button className="btn o" onClick={modal.close}>
            Cancel
          </button>
          <button
            className="btn"
            onClick={async () => {
              modal.close();
              try {
                const out = await api<{ revision: number; effectiveFrom: string; version: number }>(
                  'POST',
                  `/api/recipes/${id}/revisions`,
                  { version: await getVersion() },
                );
                onStarted(out);
                toast(`Revision ${out.revision} started`);
              } catch (e) {
                toast(errText(e));
              }
            }}
          >
            Start new revision
          </button>
        </>
      ),
    });

  return (
    <div className="card" style={s('margin-top:18px')}>
      <h3>Revisions</h3>
      <div className="bd">
        <div style={s('display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px')}>
          <span style={s('font-size:13px')}>
            <b>Revision {revision}</b> {'·'} In force since {effectiveFrom}
          </span>
          {editable && (
            <Perm perm="recipe.edit">
              {startedToday ? (
                <span style={s('font-size:12px;color:var(--mute)')}>
                  A revision already started today. Keep editing it.
                </span>
              ) : (
                <button className="btn sm o" onClick={start}>
                  Start new revision
                </button>
              )}
            </Perm>
          )}
        </div>
        {list && list.length > 1 ? (
          <div className="tw" style={s('box-shadow:none')}>
            <table>
              <thead>
                <tr>
                  <th>Revision</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Status</th>
                  <th>Replaced by</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.revision}>
                    <td>{r.revision}</td>
                    <td>{r.effectiveFrom}</td>
                    <td>{r.effectiveTo ?? 'now'}</td>
                    <td>{r.status === 'LOCKED' ? 'Locked' : 'Draft'}</td>
                    <td>{r.createdBy ?? '–'}</td>
                    <td>
                      {r.effectiveTo && (
                        <button className="btn sm o" onClick={() => view(r.revision)}>
                          View
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          list && <div style={s('font-size:12.5px;color:var(--mute)')}>No earlier revisions</div>
        )}
      </div>
    </div>
  );
}
