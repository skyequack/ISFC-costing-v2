'use client';

/** Page CSS as text (legacy copied every <style>); same-origin stylesheet rules, robust to <link> CSS in production. */
export function pageCss(): string {
  const out: string[] = [];
  for (const ss of Array.from(document.styleSheets)) {
    try {
      out.push(
        Array.from(ss.cssRules)
          .map((r) => r.cssText)
          .join('\n'),
      );
    } catch {
      /* cross-origin sheet */
    }
  }
  return out.join('\n');
}

export function downloadText(name: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  const b = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

/**
 * Open a standalone document in a new tab and print it (legacy prodPrint 2405): a Blob URL survives sandboxing better than
 * document.write; a blocked tab downloads the file instead so the click never looks like it did nothing.
 */
export function printDocument(html: string, filename: string, toast: (m: string) => void, delay = 600): void {
  let url = '';
  try {
    url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  } catch {
    /* fall through to download */
  }
  let w: Window | null = null;
  if (url) {
    try {
      w = window.open(url, '_blank');
    } catch {
      w = null;
    }
  }
  if (w) {
    setTimeout(() => {
      try {
        w!.focus();
        w!.print();
      } catch {
        /* ignore */
      }
    }, delay);
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }, 60000);
    return;
  }
  try {
    downloadText(filename, html, 'text/html;charset=utf-8');
    toast('Sheet downloaded – open it, then print or save as PDF');
  } catch {
    toast('Could not open the sheet');
  }
}
