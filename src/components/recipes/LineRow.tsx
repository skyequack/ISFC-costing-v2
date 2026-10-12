'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/components/shared/api-client';
import { Perm } from '@/components/shared/Perm';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { cur } from '@/lib/format';
import type { LineView } from '@/lib/services/card-view';
import type { PickOption } from '@/lib/services/catalog-search';
import { UNITS } from '@/lib/units';
import { CommitInput } from '@/components/shared/inputs';
import { usePerm } from '@/components/shared/session-context';
import { stagedYield } from '@/domain/recipes/yield-stages';
import { stagePct, useStagesDialog } from './StagesDialog';

export interface EditLine {
  code: string;
  qty: number;
  unit: 'Gram' | 'Ml' | 'Each' | 'Slice';
  y: number;
  yp: number | null;
  /** three-stage yield (D-70): fractions, null = not set; while any is set `y` is their product */
  yThaw: number | null;
  yCut: number | null;
  yCook: number | null;
}

/** Legacy lineRow (3237) with the ingredient autocomplete (sugSearch / pick / commitCode). */
export function LineRow(props: {
  i: number;
  l: EditLine;
  lv: LineView | undefined;
  brandId: string;
  buffer: number;
  onChange: (patch: Partial<EditLine>) => void;
  onDelete: () => void;
}) {
  const { l, lv, brandId, buffer } = props;
  const toast = useToast();
  const canEdit = usePerm()('recipe.edit');
  const openStages = useStagesDialog();
  const staged = stagedYield(l) !== null;
  const [text, setText] = useState(l.code);
  const [opts, setOpts] = useState<{ all: PickOption[]; total: number } | null>(null);
  const [hl, setHl] = useState(-1);
  const picking = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(l.code);
  }, [l.code]);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Between choosing an ingredient and the server's costed view coming back, show what the picker already told us.
  const [hint, setHint] = useState<PickOption | null>(null);
  const pending = !!hint && hint.code === l.code && lv?.name !== hint.name;
  const kind = pending ? (hint.sub ? 'sub' : 'item') : lv?.kind;
  const bad = !l.code
    ? ''
    : pending
      ? ''
      : kind === 'none'
        ? 'p-bad'
        : lv?.needConv
          ? 'p-warn'
          : lv?.err
            ? 'p-bad'
            : '';
  const rate = l.yp != null ? l.yp / 100 : buffer;

  function search(q: string) {
    clearTimeout(timer.current);
    if (q.trim().length < 1) return setOpts(null);
    timer.current = setTimeout(async () => {
      try {
        setOpts(
          await api(
            'GET',
            `/api/catalog/search?brandId=${encodeURIComponent(brandId)}&q=${encodeURIComponent(q.trim())}&limit=30`,
          ),
        );
        setHl(-1);
      } catch {
        setOpts(null);
      }
    }, 120);
  }

  function pick(o: PickOption) {
    picking.current = true;
    setText(o.code);
    setOpts(null);
    const unit = (UNITS as readonly string[]).includes(o.uom) ? (o.uom as EditLine['unit']) : l.unit;
    setHint(o);
    props.onChange({ code: o.code, unit, y: l.y > 0 ? l.y : 1 });
    toast(`${o.name}  ·  ${cur(o.price ?? 0, 6)} per ${o.uom}`);
    setTimeout(() => (picking.current = false), 300);
  }

  /** Legacy commitCode (3586): never let raw typed text become the code. */
  async function commit(val: string) {
    if (picking.current) return;
    const v = val.trim();
    if (v === l.code) return;
    if (!v) return props.onChange({ code: '' });
    try {
      const { all } = await api<{ all: PickOption[]; total: number }>(
        'GET',
        `/api/catalog/search?brandId=${encodeURIComponent(brandId)}&q=${encodeURIComponent(v)}&limit=0`,
      );
      const lc = v.toLowerCase();
      const hit =
        all.find((o) => o.code === v) ??
        all.find((o) => o.code.toLowerCase() === lc) ??
        (all.filter((o) => !o.sub && o.name.toLowerCase() === lc).length === 1
          ? all.find((o) => !o.sub && o.name.toLowerCase() === lc)
          : undefined) ??
        (all.length === 1 ? all[0] : undefined);
      if (hit) {
        const unit = (UNITS as readonly string[]).includes(hit.uom) ? (hit.uom as EditLine['unit']) : l.unit;
        setText(hit.code);
        setHint(hit);
        props.onChange({ code: hit.code, unit, y: l.y > 0 ? l.y : 1 });
      } else {
        toast(all.length ? `Several items match “${v}” – pick one from the list` : `No ingredient matches “${v}”`);
        setText(l.code);
      }
    } catch {
      setText(l.code);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') return setOpts(null);
    if (!opts?.all.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHl((h) => Math.min(opts.all.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHl((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(opts.all[hl < 0 ? 0 : hl]!);
    }
  }

  return (
    <>
      <tr>
        <td>
          <div className="srch">
            <Perm perm="recipe.edit">
              <input
                className="cell mono"
                type="text"
                value={text}
                placeholder="type a name or code"
                onChange={(e) => {
                  setText(e.target.value);
                  search(e.target.value);
                }}
                onFocus={(e) => {
                  focused.current = true;
                  search(e.target.value);
                }}
                onBlur={(e) => {
                  focused.current = false;
                  const v = e.target.value;
                  setTimeout(() => setOpts(null), 200);
                  commit(v);
                }}
                onKeyDown={onKey}
              />
            </Perm>
            <div className={`sug ${opts ? 'on' : ''}`}>
              {opts &&
                (opts.all.length ? (
                  <>
                    {opts.all.map((o, k) => (
                      <div key={o.code} className={k === hl ? 'hl' : ''} onMouseDown={() => pick(o)}>
                        <div style={s('display:flex;justify-content:space-between;align-items:baseline;gap:8px')}>
                          <span className="c">{o.code}</span>
                          <b style={s('font-size:12px;color:var(--org-dk)')}>
                            {o.price == null ? 'no price' : cur(o.price, 6)}
                          </b>
                        </div>
                        <div style={s('margin-top:1px')}>
                          {o.name}
                          {o.sub && (
                            <>
                              {' '}
                              <span className="pill p-sub">sub</span>
                            </>
                          )}
                        </div>
                        <div className="m">per {o.uom}</div>
                      </div>
                    ))}
                    {opts.total > opts.all.length && (
                      <div className="m" style={s('padding:8px 13px;text-align:center')}>
                        +{opts.total - opts.all.length} more {'–'} keep typing
                      </div>
                    )}
                  </>
                ) : (
                  <div className="m" style={s('padding:11px 13px')}>
                    No ingredient matches that
                  </div>
                ))}
            </div>
          </div>
        </td>
        <td style={s('font-size:12.5px')}>
          {l.code ? pending ? hint.name : lv?.name : <span style={s('color:var(--mute)')}>empty line</span>}
          {kind === 'sub' && (
            <span className="pill p-sub" style={s('margin-left:6px')}>
              sub
            </span>
          )}
          {bad && (
            <span className={`pill ${bad}`} style={s('margin-left:6px')}>
              {lv?.needConv ? 'needs conversion' : lv?.err || 'unknown code'}
            </span>
          )}
        </td>
        <td className="c" style={s('font-size:11.5px;color:var(--mute)')}>
          {pending ? hint.uom : lv?.uom || ''}
        </td>
        <td>
          <Perm perm="recipe.edit">
            <CommitInput
              className="cell"
              style={s('text-align:right')}
              type="number"
              step="any"
              value={l.qty || 0}
              onCommit={(v) => props.onChange({ qty: Math.max(0, parseFloat(v) || 0) })}
            />
          </Perm>
        </td>
        <td>
          <Perm perm="recipe.edit">
            <select value={l.unit} onChange={(e) => props.onChange({ unit: e.target.value as EditLine['unit'] })}>
              {UNITS.map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </Perm>
        </td>
        <td>
          <Perm perm="recipe.edit">
            <CommitInput
              className="cell"
              style={s('text-align:right')}
              type="number"
              step="any"
              min="0"
              title="Yield loss. Costed once on the batch total, exactly as the costing sheets do, so the line cost stays quantity x price."
              value={l.yp != null ? l.yp : Math.round(buffer * 1000) / 10}
              onCommit={(v) => props.onChange({ yp: Math.min(99, Math.max(0, parseFloat(v) || 0)) })}
            />
          </Perm>
          {l.code && (staged || canEdit) && (
            <div style={s('margin-top:3px;text-align:right')}>
              {canEdit ? (
                <button
                  className="btn sm o"
                  title="Thawing, cutting / trimming and cooking yields, multiplied into the line yield"
                  onClick={() => openStages(l, (patch) => props.onChange(patch))}
                >
                  {staged ? `yield ${stagePct(l.y)}%` : 'Stages'}
                </button>
              ) : (
                <span className="pill p-gr">yield {stagePct(l.y)}%</span>
              )}
            </div>
          )}
        </td>
        <td className="n mono" style={s('font-size:11.5px')}>
          {l.code ? cur((pending ? hint.price : lv?.price) ?? 0, 6) : ''}
        </td>
        <td
          className="n"
          style={s('font-weight:600')}
          title="Quantity x price, plus this line's share of the yield. Change the Yield % and this moves with it."
        >
          {l.code ? cur((lv?.cost ?? 0) * (1 + rate), 3) : ''}
          {l.code && (
            <div style={s('font-size:10px;font-weight:400;color:var(--mute)')}>raw {cur(lv?.cost ?? 0, 3)}</div>
          )}
        </td>
        <td className="c">
          <Perm perm="recipe.edit">
            <button className="btn sm d" onClick={props.onDelete}>
              {'×'}
            </button>
          </Perm>
        </td>
      </tr>
      {l.code && l.y !== 1 && l.yp != null && (
        <tr>
          <td colSpan={9} style={s('padding:0 10px 8px')}>
            <div className="note" style={s('margin:0')}>
              Yield factor and waste % are both set {'—'} waste may be counted twice
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
