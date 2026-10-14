'use client';

import { useState } from 'react';
import { api, errText } from '@/components/shared/api-client';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import type { UnitRow } from '@/lib/services/units';

/** D-103: the GM's unit list. Adds a pack unit (its factor is entered per item) and deletes an unused one. */
export function UnitsDialog({ initial, onChange }: { initial: UnitRow[]; onChange: () => void }) {
  const toast = useToast();
  const [units, setUnits] = useState(initial);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function reload() {
    const r = await api<{ units: UnitRow[] }>('GET', '/api/units');
    setUnits(r.units);
    onChange();
  }
  async function add() {
    if (!code.trim()) return toast('Type a unit name');
    setBusy(true);
    try {
      await api('POST', '/api/units', { code: code.trim() });
      setCode('');
      await reload();
      toast('Unit added');
    } catch (e) {
      toast(errText(e));
    }
    setBusy(false);
  }
  async function del(u: UnitRow) {
    setBusy(true);
    try {
      await api('DELETE', `/api/units/${encodeURIComponent(u.code)}`);
      await reload();
      toast('Unit deleted');
    } catch (e) {
      toast(errText(e));
    }
    setBusy(false);
  }

  return (
    <>
      <div className="note" style={s('margin:0 0 8px')}>
        Units for buying and counting. Gram, Kg, Ml, L, Each and Slice are fixed. A unit you add (Carton, Bag, Drum...)
        holds a different number of base units for each item, entered on the item.
      </div>
      <div className="tw">
        <table>
          <thead>
            <tr>
              <th>Unit</th>
              <th>Kind</th>
              <th className="n">Items</th>
              <th style={s('width:70px')}></th>
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <tr key={u.code}>
                <td className="mono">{u.code}</td>
                <td style={s('font-size:12px')}>
                  {u.kind === 'pack' ? 'Pack (factor per item)' : `Fixed: 1 = ${u.toBase} ${BASE_NAME[u.kind]}`}
                </td>
                <td className="n mono">{u.used}</td>
                <td className="c">
                  {u.kind === 'pack' && !u.used && (
                    <button className="btn sm o" disabled={busy} onClick={() => del(u)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={s('grid-template-columns:1fr auto;margin-top:10px')}>
        <input
          type="text"
          maxLength={16}
          placeholder="New unit, e.g. Drum"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button className="btn" disabled={busy} onClick={add}>
          Add unit
        </button>
      </div>
    </>
  );
}

const BASE_NAME: Record<string, string> = { mass: 'Gram', volume: 'Ml', each: 'Each', slice: 'Slice' };
