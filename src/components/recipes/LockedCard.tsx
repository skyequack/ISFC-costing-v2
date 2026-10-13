'use client';

import { useEffect } from 'react';
import { Acts } from '@/components/shell/Shell';
import { Perm } from '@/components/shared/Perm';
import { printStore } from '@/components/shell/print-store';
import { s } from '@/components/ui';
import type { RecipeDetail } from '@/lib/services/recipe-detail';
import type { useRecipeActions } from './actions';
import { cardHtml, type PrintBrand } from './print';

/** Legacy vLocked (3666): the approved card, read-only, with its approval history. */
export function LockedCard({
  d,
  brand,
  act,
  onPrint,
  onDone,
}: {
  d: RecipeDetail;
  brand: PrintBrand | null;
  act: ReturnType<typeof useRecipeActions>;
  onPrint: () => void;
  onDone: () => void;
}) {
  const r = d.recipe;
  const html = cardHtml(d, brand);
  useEffect(() => {
    printStore.set({ html });
    return () => printStore.set({ html: '' });
  }, [html]);
  const when = r.lockedAt ? new Date(r.lockedAt).toLocaleString() : '';
  const snap = r.costAtLock as { food?: number; priceDate?: string; overrideReason?: string } | null;

  return (
    <>
      <Acts>
        <button className="btn o" onClick={onDone}>
          {'←'} All cards
        </button>
        <button className="btn o" onClick={() => act.duplicate(r.id)}>
          Duplicate as draft
        </button>
        <button className="btn o" onClick={onPrint}>
          Print
        </button>
        <Perm perm="export">
          <button className="btn o" onClick={() => act.exportCard(r.id)}>
            Export card
          </button>
        </Perm>
        <button className="btn" onClick={() => act.unlock([r.id], r.code)}>
          {'🔓'} Unlock to edit
        </button>
      </Acts>
      <div className="lockban">
        <div className="lk">{'🔒'}</div>
        <div style={s('flex:1')}>
          <b>This card is locked and approved</b>
          <div>
            Approved by <b>{r.lockedBy || '–'}</b>
            {when && (
              <>
                {' on '}
                <span suppressHydrationWarning>{when}</span>
              </>
            )}
            . It is read-only. Reopening it needs a General Manager or Cost Controller.
          </div>
          {snap?.food != null && (
            <div style={s('font-size:12px;margin-top:3px')}>
              Cost at lock: <b>{snap.food.toFixed(3)}</b> (price list of {snap.priceDate}) {'·'} cost now:{' '}
              <b>{d.view.cost.food.toFixed(3)}</b>
              {snap.overrideReason ? ` · locked with override: ${snap.overrideReason}` : ''}
            </div>
          )}
        </div>
        <button className="btn" onClick={() => act.unlock([r.id], r.code)}>
          Unlock to edit
        </button>
      </div>
      <div className="card" style={s('overflow:hidden')}>
        <div className="bd" style={s('padding:0')}>
          <div style={s('padding:18px;background:#fff')} dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
      {r.history.length > 0 && (
        <div className="card" style={s('margin-top:18px')}>
          <h3>Approval History</h3>
          <div className="tw" style={s('box-shadow:none;border:0;border-radius:0')}>
            <table>
              <thead>
                <tr>
                  <th style={s('width:200px')}>When</th>
                  <th style={s('width:220px')}>Who</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {[...r.history].reverse().map((h, i) => (
                  <tr key={i}>
                    <td style={s('font-size:12px')} suppressHydrationWarning>
                      {new Date(h.at).toLocaleString()}
                    </td>
                    <td>
                      <b>{h.who || '–'}</b>
                    </td>
                    <td>{h.action === 'LOCK' ? 'Locked and approved' : 'Unlocked for editing'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
