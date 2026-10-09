import { textOf, unzip, ZipError, type UnzipLimits } from './zip';

/**
 * .xlsx / .csv table readers — ports of legacy rXlsxRows / rXlsxSheets / rCsvRows (5111-5240). The XML is scanned with
 * tolerant regexes (no DOMParser), so the same code runs in the browser, in a worker and in Node tests; XML entities are
 * decoded by hand. Row and cell counts are capped (D-36/D-37).
 */
export interface Sheet {
  name: string;
  rows: unknown[][];
}

export const MAX_ROWS = 20000;
export const MAX_COLS = 80;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unxml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, g: string) => {
    if (g[0] === '#') {
      const n = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[g] ?? m;
  });
}

const colIdx = (letters: string): number => {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
};

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? unxml(m[1]!) : '';
}

function tTexts(xml: string): string {
  const out: string[] = [];
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(unxml(m[1] ?? ''));
  return out.join('');
}

function sharedStrings(xml: string): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const inner = (m[1] ?? '').replace(/<rPh\b[^>]*>[\s\S]*?<\/rPh>/g, ''); // phonetic runs are not part of the text
    out.push(tTexts(inner));
  }
  return out;
}

function sheetRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const reRow = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = reRow.exec(xml))) {
    if (rows.length >= MAX_ROWS) throw new ZipError(`That sheet has more than ${MAX_ROWS} rows - split it and upload in parts.`);
    const arr: string[] = [];
    let max = -1;
    const reC = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    while ((cm = reC.exec(rm[1]!))) {
      const head = cm[1] ?? '';
      const body = cm[2] ?? '';
      const ref = attr(head, 'r').replace(/[0-9]/g, '');
      const ci = ref ? colIdx(ref) : max + 1;
      if (ci >= MAX_COLS) continue;
      const t = attr(head, 't');
      let v = '';
      if (t === 'inlineStr') v = tTexts(body);
      else {
        const ve = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        v = ve ? unxml(ve[1]!) : '';
        if (t === 's') v = shared[parseInt(v, 10)] ?? '';
      }
      arr[ci] = v;
      if (ci > max) max = ci;
    }
    for (let i = 0; i <= max; i++) if (arr[i] === undefined) arr[i] = '';
    rows.push(arr);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const relTarget = (t: string): string => (t.charAt(0) === '/' ? t.slice(1) : t.indexOf('xl/') === 0 ? t : 'xl/' + t.replace(/^\.\//, ''));

/** Every tab of a workbook (the kitchen keeps one recipe per tab). */
export async function readXlsxSheets(bytes: Uint8Array, limits?: UnzipLimits): Promise<Sheet[]> {
  const z = await unzip(bytes, limits);
  const shared = sharedStrings(textOf(z.get('xl/sharedStrings.xml')));
  const wb = textOf(z.get('xl/workbook.xml'));
  const rels = textOf(z.get('xl/_rels/workbook.xml.rels'));
  const relMap = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) relMap.set(attr(m[1]!, 'Id'), relTarget(attr(m[1]!, 'Target')));
  const out: Sheet[] = [];
  let i = 0;
  for (const m of wb.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    i++;
    const head = m[1]!;
    const name = attr(head, 'name') || `Sheet${i}`;
    const rid = attr(head, 'r:id') || attr(head, 'id');
    const path = relMap.get(rid);
    const xml = path ? textOf(z.get(path)) : '';
    if (xml) out.push({ name, rows: sheetRows(xml, shared) });
  }
  if (!out.length) {
    const xml = textOf(z.get('xl/worksheets/sheet1.xml'));
    if (!xml) throw new ZipError('The workbook has no readable first sheet.');
    out.push({ name: 'Sheet1', rows: sheetRows(xml, shared) });
  }
  return out;
}

/** Full RFC-4180 reader (quoted newlines allowed, unlike the legacy line splitter); delimiter sniffed from the first line. */
export function parseCsv(text: string): string[][] {
  const txt = text.replace(/^﻿/, '');
  const firstLine = txt.split(/\r?\n/, 1)[0] ?? '';
  const d = firstLine.split(';').length > firstLine.split(',').length ? ';' : firstLine.split('\t').length > firstLine.split(',').length ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i]!;
    if (q) {
      if (c === '"') {
        if (txt[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === d) {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && txt[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) throw new ZipError(`That file has more than ${MAX_ROWS} rows - split it and upload in parts.`);
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

/** Legacy rReadSheets: every tab of an .xlsx/.xlsm, or the one table of a CSV/TXT. Old .xls is refused with advice. */
export async function readSheets(file: { name: string; bytes: Uint8Array }): Promise<Sheet[]> {
  const n = file.name.toLowerCase();
  if (/\.(xlsx|xlsm)$/.test(n)) return readXlsxSheets(file.bytes);
  if (/\.xls$/.test(n)) throw new ZipError('Old .xls format is not supported. In Excel use Save As → .xlsx, then upload again.');
  return [{ name: file.name.replace(/\.[^.]+$/, ''), rows: parseCsv(new TextDecoder('utf-8').decode(file.bytes)) }];
}

export async function readTable(file: { name: string; bytes: Uint8Array }): Promise<unknown[][]> {
  return (await readSheets(file))[0]?.rows ?? [];
}
