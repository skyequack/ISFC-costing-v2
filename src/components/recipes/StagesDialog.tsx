'use client';

import { api, errText } from '@/components/shared/api-client';
import { createStore, useStore, type Store } from '@/components/shared/form-store';
import { useModal } from '@/components/shared/Modal';
import { usePerm } from '@/components/shared/session-context';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { parseStagePct, pctText, stagedYield, validYield } from '@/domain/recipes/yield-stages';

export interface StageValues {
  yThaw: number | null;
  yCut: number | null;
  yCook: number | null;
}

interface Form {
  thaw: string;
  cut: string;
  cook: string;
}

/** Fractions are stored (0.9); the screen shows percent (90) without float noise. */
export const stagePct = (v: number | null): string => pctText(v);

export const BAD = 'bad';
/** A stage typed as percent: blank or 0 = no stage (100%, D-93), (0,1000] = the fraction, anything else BAD. */
export const parsePct = (t: string): number | null | typeof BAD => parseStagePct(t) ?? null;

const read = (f: Form): StageValues | null => {
  const a = parsePct(f.thaw);
  const b = parsePct(f.cut);
  const c = parsePct(f.cook);
  if (a === BAD || b === BAD || c === BAD) return null;
  return { yThaw: a, yCut: b, yCook: c };
};

/** Dialog for the three-stage line yield (D-70, D-85): thawing, cutting / trimming and cooking multiply into the line yield. */
export function useStagesDialog() {
  const modal = useModal();
  const toast = useToast();
  const can = usePerm();
  /** `item`: the line's raw material, which shows "Save to raw material" to users who may edit ingredients (D-93) */
  return (
    line: StageValues & { y: number },
    onSave: (patch: StageValues & { y: number }) => void,
    item?: { code: string },
  ) => {
    const st = createStore<Form>({ thaw: stagePct(line.yThaw), cut: stagePct(line.yCut), cook: stagePct(line.yCook) });
    const hadStages = stagedYield(line) !== null;
    function save(clear: boolean) {
      const v = clear ? { yThaw: null, yCut: null, yCook: null } : read(st.get());
      const product = v ? stagedYield(v) : null;
      if (!v || (product !== null && !validYield(product)))
        return toast('Each stage must be above 0%, and the three together up to 1000%');
      onSave({ ...v, y: product ?? line.y }); // clearing keeps the combined yield as the line's own
      modal.close();
    }
    async function saveToItem() {
      const v = read(st.get());
      const product = v ? stagedYield(v) : null;
      if (!item || !v || (product !== null && !validYield(product)))
        return toast('Each stage must be above 0%, and the three together up to 1000%');
      if (product === null) return toast('Enter at least one stage to save to the raw material');
      try {
        await api('PUT', '/api/ingredients/yields', { code: item.code, ...v });
        toast('Yields saved to the raw material');
      } catch (e) {
        toast(errText(e));
      }
    }
    modal.open({
      title: 'Yield stages',
      body: <StagesBody st={st} />,
      foot: (
        <>
          <button className="btn o" onClick={modal.close}>
            Cancel
          </button>
          {item && can('items.edit') && (
            <button className="btn o" onClick={saveToItem}>
              Save to raw material
            </button>
          )}
          {hadStages && (
            <button className="btn o" onClick={() => save(true)}>
              Clear stages
            </button>
          )}
          <button className="btn" onClick={() => save(false)}>
            Save
          </button>
        </>
      ),
    });
  };
}

function StagesBody({ st }: { st: Store<Form> }) {
  const f = useStore(st);
  const v = read(f);
  const p = v ? stagedYield(v) : null;
  const field = (key: keyof Form, label: string, autoFocus = false) => (
    <div className="field">
      <label className="fl">{label}</label>
      <input
        type="number"
        step="any"
        min="0"
        className="cell"
        style={s('text-align:right')}
        value={f[key]}
        placeholder="100"
        autoFocus={autoFocus}
        onChange={(e) => st.set({ [key]: e.target.value })}
      />
    </div>
  );
  return (
    <>
      <div className="note" style={s('margin:0 0 12px')}>
        Each stage keeps this share of the weight; the three multiply into the line yield. Leave a stage blank (or 0) if
        it does not apply.
      </div>
      {field('thaw', 'Thawing %', true)}
      {field('cut', 'Cutting / trimming %')}
      {field('cook', 'Cooking %')}
      <div style={s('font-size:13px')}>
        Combined yield: <b>{v === null ? 'check the values' : p === null ? 'not set' : `${stagePct(p)}%`}</b>
      </div>
    </>
  );
}
