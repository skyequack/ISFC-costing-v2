'use client';

import { useCallback, useState } from 'react';
import { useModal } from '@/components/shared/Modal';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { errText } from '@/components/shared/api-client';
import { downloadFile } from './download';

type Kind = 'count' | 'receipt';

const TEXT: Record<Kind, { title: string; help: string; path: string }> = {
  count: {
    title: 'Stock counts template',
    help: 'Every ingredient you can use, with the quantity left empty. Fill in what was counted, then upload it from the Stock screen.',
    path: 'stock-counts-template',
  },
  receipt: {
    title: 'Stock receipts template',
    help: 'Every ingredient you can use, with the quantity left empty. Fill in what was delivered, then upload it from the Stock screen.',
    path: 'stock-receipts-template',
  },
};

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function TemplateBody({ kind, sites, onDone }: { kind: Kind; sites: string[]; onDone: () => void }) {
  const toast = useToast();
  const [site, setSite] = useState(sites[0] ?? '');
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);

  if (!sites.length)
    return (
      <div style={s('text-align:center;padding:10px 0')}>
        <p>No sites yet.</p>
        <p style={s('font-size:12px;color:var(--mute)')}>A brand&apos;s sites are added in Cost Settings.</p>
      </div>
    );

  async function download() {
    setBusy(true);
    try {
      await downloadFile(
        `/api/export/${TEXT[kind].path}?loc=${encodeURIComponent(site)}&date=${encodeURIComponent(date)}`,
        'ISFC-stock.csv',
      );
      toast('Template downloaded');
      onDone();
    } catch (e) {
      toast(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p style={s('font-size:13px;color:var(--mute);margin-bottom:14px')}>{TEXT[kind].help}</p>
      <div style={s('display:flex;gap:10px;flex-wrap:wrap;align-items:center')}>
        <label className="fl" style={s('margin:0')}>
          Site
        </label>
        <select value={site} onChange={(e) => setSite(e.target.value)} style={s('max-width:200px')}>
          {sites.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <label className="fl" style={s('margin:0')}>
          Date
        </label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div style={s('display:flex;gap:9px;margin-top:16px')}>
        <button
          className="btn"
          style={s('flex:1;justify-content:center')}
          disabled={busy || !date || !site}
          onClick={download}
        >
          Download template
        </button>
      </div>
    </>
  );
}

/** Stock counts / receipts template picked by site and day, filled with the ingredients the user may use (D-86). */
export function useStockTemplate(sites: string[]) {
  const modal = useModal();
  return useCallback(
    (kind: Kind) =>
      modal.open({
        title: TEXT[kind].title,
        body: <TemplateBody kind={kind} sites={sites} onDone={modal.close} />,
      }),
    [modal, sites],
  );
}
