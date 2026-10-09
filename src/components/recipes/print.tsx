'use client';

import { useCallback } from 'react';
import { useModal } from '@/components/shared/Modal';
import { useToast } from '@/components/shared/Toast';
import { s } from '@/components/ui';
import { printStore } from '@/components/shell/print-store';
import { buildCardHTML, esc, type PrintCard } from '@/lib/print/card';
import type { RecipeDetail } from '@/lib/services/recipe-detail';

export interface PrintBrand {
  id?: string;
  name: string;
  nameAr: string | null;
  color: string;
  ink: string | null;
  logoUrl: string | null;
}

/** Stored card + server-costed view -> the data buildCardHTML needs (legacy buildCardHTML reads the live card). */
export function toPrintCard(d: RecipeDetail, brand: PrintBrand | null): PrintCard {
  const r = d.recipe;
  return {
    name: r.name,
    code: r.code,
    cat: r.category,
    type: r.type,
    status: r.status,
    lockedBy: r.lockedBy,
    brand: brand ? { name: brand.name, nameAr: brand.nameAr, color: brand.color, ink: brand.ink } : null,
    logoUrl: brand?.logoUrl ?? '/assets/logo.png',
    photoUrl: r.photoUrl,
    lines: r.lines
      .map((l, i) => ({ l, v: d.view.lines[i]! }))
      .filter((x) => x.l.code)
      .map(({ l, v }) => ({ code: l.code, name: v.name, uom: v.uom, qty: l.qty, unit: l.unit, y: l.y, price: v.price, cost: v.cost, kind: v.kind })),
    method: r.method,
    c: d.view.cost,
    settings: d.settings,
    printedOn: new Date().toLocaleDateString(),
  };
}

export const cardHtml = (d: RecipeDetail, brand: PrintBrand | null) => buildCardHTML(toPrintCard(d, brand));

/** Every same-origin stylesheet rule as text — the legacy "copy every <style>" (cardDocument 5884), robust to <link> CSS. */
function pageCss(): string {
  const out: string[] = [];
  for (const ss of Array.from(document.styleSheets)) {
    try {
      out.push(Array.from(ss.cssRules).map((r) => r.cssText).join('\n'));
    } catch {
      /* cross-origin sheet: skipped */
    }
  }
  return out.join('\n');
}

/** Blob documents cannot use relative URLs, so images are fetched and inlined as data URLs at print time (D-49). */
export async function inlineImages(html: string): Promise<string> {
  const urls = [...new Set([...html.matchAll(/<img[^>]*\ssrc="(\/[^"]+)"/g)].map((m) => m[1]!))];
  let out = html;
  for (const u of urls) {
    try {
      const res = await fetch(u.replace(/&amp;/g, '&'));
      if (!res.ok) continue;
      const blob = await res.blob();
      const data = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
      out = out.split(`src="${u}"`).join(`src="${data}"`);
    } catch {
      /* leave the URL; the image simply will not print */
    }
  }
  return out;
}

export function cardDocument(html: string, code: string, name: string): string {
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<title>${esc(code)} ${esc(name || 'Recipe Card')}</title>` +
    `<style>${pageCss()}\nbody{background:#fff;padding:14mm 11mm}` +
    `\n#printcard{display:block!important}\n@media print{#printcard{display:block!important}}` +
    `\n@page{size:A4 portrait;margin:13mm 11mm}` +
    `\n@media print{body{padding:0}}</style></head>` +
    `<body class="hascard"><div id="printcard">${html}</div></body></html>`
  );
}

function download(name: string, text: string, mime = 'text/plain;charset=utf-8') {
  const b = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

const inFrame = () => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
};

/** Legacy printMenu (5860): Print now / show on screen / new tab / download — plus the "nothing printed?" fallback. */
export function usePrintMenu(): (d: RecipeDetail, brand: PrintBrand | null) => void {
  const modal = useModal();
  const toast = useToast();

  return useCallback(
    (d, brand) => {
      const html = cardHtml(d, brand);
      const code = d.recipe.code;
      const name = d.recipe.name;

      const closePreview = () => printStore.set({ preview: null, html: printStore.get().html });
      const downloadCard = async () => {
        const doc = cardDocument(await inlineImages(html), code, name);
        download(`${code || 'recipe'}-${(name || 'card').replace(/[^\w-]+/g, '-')}.html`, doc, 'text/html;charset=utf-8');
        toast('Card downloaded - open it, then print or save as PDF');
      };
      const printTab = async () => {
        const doc = cardDocument(await inlineImages(html), code, name);
        let url = '';
        try {
          url = URL.createObjectURL(new Blob([doc], { type: 'text/html;charset=utf-8' }));
        } catch {
          return void downloadCard();
        }
        let w: Window | null = null;
        try {
          w = window.open(url, '_blank');
        } catch {
          w = null;
        }
        if (!w) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            /* ignore */
          }
          toast('The new tab was blocked - downloading the card instead');
          return void downloadCard();
        }
        setTimeout(() => {
          try {
            w!.focus();
            w!.print();
          } catch {
            /* ignore */
          }
        }, 600);
        setTimeout(() => {
          try {
            URL.revokeObjectURL(url);
          } catch {
            /* ignore */
          }
        }, 60000);
      };
      const preview = () => {
        printStore.set({ html, preview: { title: `${code} · ${name}`, tab: printTab, download: downloadCard, done: closePreview } });
        window.scrollTo(0, 0);
        toast('Use your browser’s own Print or Share to save this as PDF');
      };
      const fallback = (why: string) =>
        modal.open({
          title: 'Nothing printed?',
          body: (
            <>
              <p style={s('font-size:13.5px;margin-bottom:12px')}>{why} Every option below produces the identical card.</p>
              <div style={s('display:flex;flex-direction:column;gap:9px')}>
                <button className="btn" style={s('justify-content:center')} onClick={() => (modal.close(), preview())}>
                  Show the card on screen
                </button>
                <button className="btn o" style={s('justify-content:center')} onClick={() => (modal.close(), printTab())}>
                  Open the card in a new tab
                </button>
                <button className="btn o" style={s('justify-content:center')} onClick={() => (modal.close(), downloadCard())}>
                  Download the card as a file
                </button>
              </div>
              <div className="note" style={s('margin-top:14px')}>
                <b>Most reliable:</b> open the system in its own browser tab rather than inside another window, then Print works
                normally.
              </div>
            </>
          ),
          foot: (
            <button className="btn o" onClick={modal.close}>
              Cancel
            </button>
          ),
        });

      /* A sandboxed frame ignores window.print() silently: watch for 'beforeprint' and offer the routes that work. */
      const printNow = () => {
        printStore.set({ html });
        let opened = false;
        const seen = () => (opened = true);
        window.addEventListener('beforeprint', seen);
        setTimeout(() => {
          try {
            window.print();
          } catch {
            opened = false;
          }
          setTimeout(() => {
            window.removeEventListener('beforeprint', seen);
            if (!opened) fallback('The print dialog did not open. This window is not allowed to print.');
          }, 1000);
        }, 150);
      };

      modal.open({
        title: 'Print or save as PDF',
        body: (
          <>
            <p style={s('font-size:13.5px;margin-bottom:12px')}>
              <b>{name}</b> {'–'} one A4 page.
            </p>
            <div className="note" style={s('margin:0 0 14px')}>
              <b>To save a PDF:</b> click <b>Print now</b>, then in the dialog set <b>Destination</b> (or <b>Printer</b>) to{' '}
              <b>Save as PDF</b> and press Save.
            </div>
            {inFrame() && (
              <div className="rolebar" style={s('margin:0 0 14px')}>
                This window is inside another page, which usually blocks printing. <b>Show the card on screen</b> or{' '}
                <b>Open in a new tab</b> will still work.
              </div>
            )}
            <div style={s('display:flex;flex-direction:column;gap:9px')}>
              <button className="btn" style={s('justify-content:center')} onClick={() => (modal.close(), printNow())}>
                Print now
              </button>
              <button className="btn o" style={s('justify-content:center')} onClick={() => (modal.close(), preview())}>
                Show the card on screen
              </button>
              <button className="btn o" style={s('justify-content:center')} onClick={() => (modal.close(), printTab())}>
                Open the card in a new tab
              </button>
              <button className="btn o" style={s('justify-content:center')} onClick={() => (modal.close(), downloadCard())}>
                Download the card as a file
              </button>
            </div>
            <div style={s('font-size:11.5px;color:var(--mute);margin-top:14px')}>
              If <b>Print now</b> does nothing, this window is not allowed to open a print dialog. The other three all give you the
              identical card.
            </div>
          </>
        ),
        foot: (
          <button className="btn o" onClick={modal.close}>
            Cancel
          </button>
        ),
      });
    },
    [modal, toast],
  );
}
