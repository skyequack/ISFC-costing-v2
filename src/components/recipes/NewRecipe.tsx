'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { api, errText, uploadImage } from '@/components/shared/api-client';
import { createStore, useStore, type Store } from '@/components/shared/form-store';
import { imgError, readPhoto } from '@/components/shared/images';
import { useModal } from '@/components/shared/Modal';
import { Perm } from '@/components/shared/Perm';
import { useSession } from '@/components/shared/session-context';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';

interface Form {
  brandId: string;
  photo: Blob | null;
  preview: string | null;
  kb: number;
  busy: boolean;
}

/**
 * "+ New Recipe Card". Legacy created the card straight away in the active workspace and asked for a brand first when
 * there was none. D-48(a): the dialog also offers an optional photo (uploaded right after the card exists).
 */
export function useNewRecipe(): () => void {
  const { workspace, brands } = useSession();
  const modal = useModal();
  const toast = useToast();
  const router = useRouter();

  return useCallback(() => {
    const st = createStore<Form>({ brandId: workspace?.id ?? '', photo: null, preview: null, kb: 0, busy: false });

    async function create() {
      const f = st.get();
      if (!f.brandId) {
        toast('Choose a brand first');
        return;
      }
      st.set({ busy: true });
      try {
        const { id } = await api<{ id: string }>('POST', '/api/recipes', { brandId: f.brandId, type: 'MENU' });
        const b = brands.find((x) => x.id === f.brandId);
        let note = '';
        if (f.photo) {
          try {
            await uploadImage(`/api/recipes/${id}/photo`, f.photo);
          } catch (e) {
            note = ` - the photo was not added (${errText(e)}); add it in the card`;
          }
        }
        modal.close();
        if (f.brandId !== workspace?.id) await api('POST', '/api/workspace', { brandId: f.brandId });
        router.push(`/edit/${id}`);
        router.refresh();
        toast(`Card created in ${b?.name ?? 'the brand'}${note}`);
      } catch (e) {
        st.set({ busy: false });
        toast(errText(e));
      }
    }

    modal.open({
      title: workspace ? 'New recipe card' : 'Choose a brand first',
      body: <NewBody st={st} />,
      foot: (
        <>
          <button className="btn o" onClick={modal.close}>
            Cancel
          </button>
          <NewFoot st={st} onCreate={create} />
        </>
      ),
    });
  }, [workspace, brands, modal, toast, router]);
}

function NewFoot({ st, onCreate }: { st: Store<Form>; onCreate: () => void }) {
  const f = useStore(st);
  return (
    <button className="btn" disabled={f.busy || !f.brandId} onClick={onCreate}>
      {f.busy ? 'Creating…' : 'Create card'}
    </button>
  );
}

function NewBody({ st }: { st: Store<Form> }) {
  const f = useStore(st);
  const { brands, workspace } = useSession();
  const toast = useToast();

  async function choosePhoto(file: File | undefined) {
    if (!file) return;
    toast('Processing the photo…');
    try {
      const out = await readPhoto(file);
      if (f.preview) URL.revokeObjectURL(f.preview);
      st.set({ photo: out.blob, preview: URL.createObjectURL(out.blob), kb: out.kb });
      toast(`Photo ready · ${out.w}×${out.h} · ${out.kb} KB`);
    } catch (e) {
      toast(imgError(e));
    }
  }

  return (
    <>
      {!workspace && (
        <>
          <p style={s('font-size:13.5px;margin-bottom:14px')}>
            Every recipe card belongs to a brand. Pick the workspace this dish is for.
          </p>
          <div className="brow">
            {brands.map((b) => (
              <button
                key={b.id}
                type="button"
                className="bpick"
                style={f.brandId === b.id ? s('border-color:var(--org)') : undefined}
                onClick={() => st.set({ brandId: b.id })}
              >
                {b.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={b.logoUrl} alt="" style={s('height:30px;object-fit:contain;display:block;margin-bottom:5px')} />
                ) : (
                  <span className="bt-code" style={{ background: b.color, color: b.onSolid }}>
                    {b.code}
                  </span>
                )}
                <b>{b.name}</b>
                <i>{b.cards} cards</i>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="field" style={s('margin-top:14px')}>
        <label className="fl">Dish Photo (optional)</label>
        <div className={`phbox ${f.preview ? 'has' : ''}`}>
          {f.preview ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={f.preview} alt="" />
              <div className="phact">
                <Perm perm="recipe.edit">
                  <label className="btn sm o">
                    Replace
                    <input type="file" accept="image/*" style={s('display:none')} onChange={(e) => choosePhoto(e.target.files?.[0])} />
                  </label>
                </Perm>
                <button className="btn sm d" onClick={() => st.set({ photo: null, preview: null, kb: 0 })}>
                  Remove
                </button>
                <span className="phkb">{f.kb} KB</span>
              </div>
            </>
          ) : (
            <label className="phadd">
              <span className="pl">{'＋'}</span>
              <span>Add a photo</span>
              <input type="file" accept="image/*" style={s('display:none')} onChange={(e) => choosePhoto(e.target.files?.[0])} />
            </label>
          )}
        </div>
      </div>
    </>
  );
}
