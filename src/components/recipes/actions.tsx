'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { api, ClientApiError, errText } from '@/components/shared/api-client';
import { createStore, useStore, type Store } from '@/components/shared/form-store';
import { useModal } from '@/components/shared/Modal';
import { usePerm, useSession } from '@/components/shared/session-context';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { cur, pct } from '@/lib/format';

/** Cards deleted most recently (legacy `trash`): one batch the user can undo straight afterwards. Session memory only. */
let trash: string[] = [];
export const trashCount = () => trash.length;

export interface CardFacts {
  id: string;
  code: string;
  name: string;
  type: 'menu' | 'sub';
  locked: boolean;
  food: number;
  fcPct: number | null;
  sp: number;
  net: number;
  err: string;
}

/** Shared by the Recipe Cards list, the Dashboard and the editor: duplicate, delete (+undo), lock, unlock. */
export function useRecipeActions(target: number) {
  const router = useRouter();
  const toast = useToast();
  const modal = useModal();
  const can = usePerm();
  const { name } = useSession();

  const refresh = useCallback(() => router.refresh(), [router]);

  const duplicate = useCallback(
    async (id: string) => {
      if (!can('recipe.create')) return toast('Your role cannot do that');
      try {
        const { id: nid } = await api<{ id: string }>('POST', `/api/recipes/${id}/duplicate`);
        toast('Card duplicated');
        router.push(`/edit/${nid}`);
        router.refresh();
      } catch (e) {
        toast(errText(e));
      }
    },
    [can, router, toast],
  );

  const undoDelete = useCallback(async () => {
    if (!can('recipe.delete')) return toast('Your role cannot do that');
    if (!trash.length) return toast('Nothing to restore');
    const ids = trash;
    try {
      for (const id of ids) await api('POST', `/api/recipes/${id}/restore`);
      trash = [];
      toast(ids.length === 1 ? 'Card restored' : `${ids.length} cards restored`);
      refresh();
    } catch (e) {
      toast(errText(e));
    }
  }, [can, refresh, toast]);

  /** Legacy confirmDelete (2922): lists what still uses the codes, then asks. */
  const confirmDelete = useCallback(
    async (cards: Pick<CardFacts, 'id' | 'code' | 'name' | 'type' | 'locked'>[], after?: () => void) => {
      if (!can('recipe.delete')) return toast('Your role cannot do that');
      if (cards.some((c) => c.locked) && !can('recipe.unlock'))
        return toast(
          cards.length === 1
            ? 'That card is approved and locked – your access level cannot delete it'
            : 'The selection includes approved cards – your access level cannot delete those',
        );
      let refs = { lines: 0, cards: [] as string[], codes: [] as string[] };
      try {
        refs = await api('POST', '/api/recipes/references', { ids: cards.map((c) => c.id) });
      } catch {
        /* the warning is advisory; deleting is still guarded by the server */
      }
      const many = cards.length > 1;
      const run = async () => {
        try {
          await api('POST', '/api/recipes/bulk', { action: 'delete', ids: cards.map((c) => c.id) });
          trash = cards.map((c) => c.id);
          modal.close();
          toast(many ? `Deleted ${cards.length} recipe cards` : `Deleted “${cards[0]!.name}”`, {
            label: 'UNDO',
            fn: undoDelete,
          });
          after?.();
          refresh();
        } catch (e) {
          toast(errText(e));
        }
      };
      modal.open({
        title: many ? `Delete ${cards.length} recipe cards` : 'Delete recipe card',
        body: (
          <>
            <p style={s('font-size:13.5px')}>
              You are about to delete {many ? <b>{cards.length} cards</b> : <b>{cards[0]!.name}.</b>}
              {many && ':'}
            </p>
            {many && (
              <ul style={s('margin:10px 0 0 20px;font-size:13px;max-height:170px;overflow:auto')}>
                {cards.map((r) => (
                  <li key={r.id} style={s('margin-bottom:3px')}>
                    <b>{r.code || 'no code'}</b> {'–'} {r.name}{' '}
                    {r.type === 'sub' && <span className="pill p-sub">sub</span>}
                  </li>
                ))}
              </ul>
            )}
            {refs.lines > 0 && (
              <div className="note r" style={s('margin-top:14px')}>
                <b>Warning.</b> {refs.lines} ingredient line{refs.lines === 1 ? '' : 's'} on {refs.cards.length} other
                card
                {refs.cards.length === 1 ? '' : 's'} still use{refs.lines === 1 ? 's' : ''}{' '}
                {refs.codes.map((c, i) => (
                  <span key={c}>
                    {i > 0 && ', '}
                    <b>{c}</b>
                  </span>
                ))}
                . Those lines will stop costing and will show as CODE NOT FOUND.
                <div style={s('margin-top:6px;font-size:11.5px')}>{refs.cards.slice(0, 6).join(' · ')}</div>
              </div>
            )}
            <p style={s('margin-top:14px;color:var(--mute);font-size:12.5px')}>
              You will get one chance to undo straight afterwards.
            </p>
          </>
        ),
        foot: (
          <>
            <button className="btn o" onClick={modal.close}>
              Cancel
            </button>
            <button className="btn d" onClick={run}>
              Delete {many ? `${cards.length} cards` : 'card'}
            </button>
          </>
        ),
      });
    },
    [can, modal, refresh, toast, undoDelete],
  );

  /** Legacy lockRecipe / bulkLock modal; D-29: a GM may override a blocked lock with a reason. */
  const lock = useCallback(
    (cards: CardFacts[], after?: () => void) => {
      if (!can('recipe.lock')) return toast('Your access level cannot approve recipe cards');
      const list = cards.filter((c) => !c.locked);
      if (!list.length) return toast('Nothing selected is unlocked');
      const st = createStore({ by: name, reason: '', needReason: false, problem: '', busy: false });
      const single = list.length === 1 ? list[0]! : null;

      async function run() {
        const f = st.get();
        const who = f.by.trim();
        if (!who) return toast(single ? 'Enter who is approving this' : 'Enter who is approving these');
        st.set({ busy: true });
        try {
          if (single)
            await api('POST', `/api/recipes/${single.id}/lock`, {
              approvedBy: who,
              overrideReason: f.needReason ? f.reason.trim() || undefined : undefined,
            });
          else await api('POST', '/api/recipes/bulk', { action: 'lock', ids: list.map((c) => c.id), approvedBy: who });
          modal.close();
          toast(single ? `${single.code} locked by ${who}` : `${list.length} cards locked`);
          after?.();
          refresh();
        } catch (e) {
          st.set({ busy: false });
          const ce = e instanceof ClientApiError ? e : null;
          if (ce && ce.status === 422 && (ce.details as { overridable?: boolean } | undefined)?.overridable)
            st.set({ needReason: true, problem: ce.message });
          else if (ce && ce.status === 422) st.set({ problem: ce.message });
          else toast(errText(e));
        }
      }

      modal.open({
        title: single ? 'Lock and approve this card' : `Lock ${list.length} cards`,
        body: <LockBody st={st} single={single} count={list.length} target={target} />,
        foot: (
          <>
            <button className="btn o" onClick={modal.close}>
              Cancel
            </button>
            <LockFoot st={st} run={run} label={single ? '🔒 Lock & approve' : `Lock ${list.length} cards`} />
          </>
        ),
      });
    },
    [can, modal, name, refresh, target, toast],
  );

  const unlock = useCallback(
    async (ids: string[], code?: string, after?: () => void) => {
      if (!can('recipe.unlock'))
        return toast(
          ids.length > 1
            ? 'Only a Cost Controller or General Manager can reopen approved cards'
            : 'Only a Cost Controller or General Manager can reopen an approved card',
        );
      try {
        await api('POST', '/api/recipes/bulk', { action: 'unlock', ids });
        toast(ids.length === 1 ? `${code ?? 'Card'} unlocked – it is editable again` : `${ids.length} cards unlocked`);
        after?.();
        refresh();
      } catch (e) {
        toast(errText(e));
      }
    },
    [can, refresh, toast],
  );

  return { duplicate, confirmDelete, undoDelete, lock, unlock };
}

function LockFoot({ st, run, label }: { st: Store<{ busy: boolean }>; run: () => void; label: string }) {
  const f = useStore(st);
  return (
    <button className="btn g" disabled={f.busy} onClick={run}>
      {label}
    </button>
  );
}

function LockBody({
  st,
  single,
  count,
  target,
}: {
  st: Store<{ by: string; reason: string; needReason: boolean; problem: string }>;
  single: CardFacts | null;
  count: number;
  target: number;
}) {
  const f = useStore(st);
  return (
    <>
      {single ? (
        <>
          <p style={s('font-size:13.5px')}>
            <b>
              {single.code} {'–'} {single.name}
            </b>
          </p>
          <div className="lockstat">
            <div>
              <span>Food cost</span>
              <b>{cur(single.food)}</b>
            </div>
            <div>
              <span>Food cost %</span>
              <b className={single.fcPct == null ? '' : single.fcPct <= target ? 'ok' : 'bad'}>{pct(single.fcPct)}</b>
            </div>
            <div>
              <span>Sales price</span>
              <b>{single.sp ? cur(single.sp) : 'not set'}</b>
            </div>
            <div>
              <span>Net profit</span>
              <b>{single.sp ? cur(single.net) : '–'}</b>
            </div>
          </div>
          {single.err && (
            <div className="note r" style={s('margin-top:12px')}>
              This card is incomplete: {single.err}. Locking it will freeze a cost you cannot rely on.
            </div>
          )}
          {!single.sp && single.type === 'menu' && (
            <div className="note r" style={s('margin-top:12px')}>
              No sales price set.
            </div>
          )}
        </>
      ) : (
        <p style={s('font-size:13.5px')}>These {count} cards become read-only. Reopening needs the manager PIN.</p>
      )}
      {f.problem && (
        <div className="note r" style={s('margin-top:12px')}>
          {f.problem}
        </div>
      )}
      <div className="field" style={s('margin-top:14px')}>
        <label className="fl">Approved by</label>
        <input
          type="text"
          className="cell"
          value={f.by}
          placeholder="Your name"
          autoFocus
          onChange={(e) => st.set({ by: e.target.value })}
        />
      </div>
      {f.needReason && (
        <div className="field">
          <label className="fl">Reason for locking despite the problems above</label>
          <input type="text" className="cell" value={f.reason} onChange={(e) => st.set({ reason: e.target.value })} />
        </div>
      )}
      {single && (
        <div className="note" style={s('margin:0')}>
          Once locked the card becomes read-only. Reopening it needs the manager PIN.
        </div>
      )}
    </>
  );
}
