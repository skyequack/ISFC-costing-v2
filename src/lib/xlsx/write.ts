import { bytesOf, zipStore } from './zip';

const xEsc = (s: unknown): string =>
  String(s == null ? '' : s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m] as string);

export function colName(i: number): string {
  let s = '';
  i++;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = (i - m - 1) / 26;
  }
  return s;
}

/** Control characters are illegal in XML 1.0; Excel refuses the whole file for one of them. */
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Legacy rSheetXml (5273): inline strings, bold header row, numeric cells for plain numbers below the header. */
export function sheetXml(rows: unknown[][]): string {
  const body = rows
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">` +
        r
          .map((c, ci) => {
            const ref = colName(ci) + (ri + 1);
            const raw = c == null ? '' : String(c);
            if (raw === '') return '';
            const isNum = /^-?\d+(\.\d+)?$/.test(raw.trim()) && ri > 0;
            return isNum
              ? `<c r="${ref}"><v>${raw.trim()}</v></c>`
              : `<c r="${ref}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xEsc(clean(raw))}</t></is></c>`;
          })
          .join('') +
        '</row>',
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** A real .xlsx (stored zip), one sheet — legacy dlXlsx (5286). */
export function xlsxBytes(rows: unknown[][], sheetName = 'Recipes'): Uint8Array {
  const F = (name: string, s: string) => ({ name, data: bytesOf(s) });
  return zipStore([
    F(
      '[Content_Types].xml',
      `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ),
    F(
      '_rels/.rels',
      `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    F(
      'xl/workbook.xml',
      `${HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    F(
      'xl/_rels/workbook.xml.rels',
      `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    F(
      'xl/styles.xml',
      `${HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    ),
    F('xl/worksheets/sheet1.xml', sheetXml(rows)),
  ]);
}
