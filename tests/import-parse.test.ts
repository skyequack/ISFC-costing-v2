import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { csvCell, csvLine } from '@/lib/csv';
import { iCode, iJunk, mapHeader, parseItemRows } from '@/lib/import/items';
import { blockConvert, blockHeaderRow, parseRecipeSheets, parseYield, RTPL_HEAD, recipeTplRows } from '@/lib/import/recipes';
import { parseCsv, readSheets, readXlsxSheets } from '@/lib/xlsx/read';
import { xlsxBytes } from '@/lib/xlsx/write';
import { crc32, unzip, zipStore, ZipError } from '@/lib/xlsx/zip';

describe('CSV writer (D-36) and reader', () => {
  it('quotes commas, quotes and newlines; neutralises formula starters in text only', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell(-5)).toBe('-5'); // numbers are not text
    expect(csvCell(null)).toBe('');
    expect(csvLine(['a', 1, 'b,c'])).toBe('a,1,"b,c"');
  });
  it('reads quoted newlines, BOM, semicolon and tab delimiters', () => {
    expect(parseCsv('﻿a,b\n"x\ny",2\n')).toEqual([['a', 'b'], ['x\ny', '2']]);
    expect(parseCsv('a;b;c\n1;2;3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\r\n1,2\r\n\r\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });
});

describe('xlsx writer / reader / zip', () => {
  const rows = [['Brand', 'Name', 'Qty'], ['GRM', 'Tom & "Jerry" <x>', '12.5'], ['', 'lineé', '007'], ['A', '', '']];
  it('round-trips through our own writer (stored zip)', async () => {
    const sheets = await readXlsxSheets(xlsxBytes(rows));
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.name).toBe('Recipes');
    expect(sheets[0]!.rows).toEqual([['Brand', 'Name', 'Qty'], ['GRM', 'Tom & "Jerry" <x>', '12.5'], ['', 'lineé', '007'], ['A']].map((r, i) => (i === 3 ? ['A'] : r)));
  });
  it('writes numbers as numeric cells below the header and text in the header', () => {
    const bytes = xlsxBytes([['n'], ['5']]);
    return unzip(bytes).then((z) => {
      const xml = new TextDecoder().decode(z.get('xl/worksheets/sheet1.xml'));
      expect(xml).toContain('<c r="A2"><v>5</v></c>');
      expect(xml).toContain('t="inlineStr" s="1"');
    });
  });
  it('reads a deflate-compressed workbook with shared strings (what Excel produces)', async () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const files: { name: string; data: Uint8Array }[] = [
      { name: 'xl/workbook.xml', data: enc('<workbook xmlns:r="x"><sheets><sheet name="Tab 1" sheetId="1" r:id="rId1"/><sheet name="Tab &amp; 2" sheetId="2" r:id="rId2"/></sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: enc('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>') },
      { name: 'xl/sharedStrings.xml', data: enc('<sst><si><t>Hello</t></si><si><r><t>Rich </t></r><r><t>text</t></r><rPh sb="0"><t>PHONETIC</t></rPh></si></sst>') },
      { name: 'xl/worksheets/sheet1.xml', data: enc('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>3</v></c></row><row r="2"><c r="B2" t="s"><v>1</v></c></row></sheetData></worksheet>') },
      { name: 'xl/worksheets/sheet2.xml', data: enc('<worksheet><sheetData><row><c t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>') },
    ];
    // build a deflated zip by hand: reuse zipStore for structure, then patch each entry to method 8
    const parts: Uint8Array[] = [];
    const cd: Uint8Array[] = [];
    let off = 0;
    for (const f of files) {
      const nm = enc(f.name);
      const comp = new Uint8Array(deflateRawSync(f.data));
      const lh = new Uint8Array(30 + nm.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(8, 8, true);
      lv.setUint32(18, comp.length, true);
      lv.setUint32(22, f.data.length, true);
      lv.setUint16(26, nm.length, true);
      lh.set(nm, 30);
      parts.push(lh, comp);
      const ch = new Uint8Array(46 + nm.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(10, 8, true);
      cv.setUint32(20, comp.length, true);
      cv.setUint32(24, f.data.length, true);
      cv.setUint16(28, nm.length, true);
      cv.setUint32(42, off, true);
      ch.set(nm, 46);
      cd.push(ch);
      off += lh.length + comp.length;
    }
    const cdSize = cd.reduce((a, b) => a + b.length, 0);
    const eo = new Uint8Array(22);
    const ev = new DataView(eo.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, off, true);
    const zip = new Uint8Array([...parts, ...cd, eo].flatMap((p) => [...p]));
    const sheets = await readSheets({ name: 'book.xlsx', bytes: zip });
    expect(sheets.map((s) => s.name)).toEqual(['Tab 1', 'Tab & 2']);
    expect(sheets[0]!.rows).toEqual([['Hello', '', '3'], ['', 'Rich text']]); // phonetic run skipped
    expect(sheets[1]!.rows).toEqual([['x']]);
  });
  it('refuses garbage, old .xls, too many parts and zip bombs', async () => {
    await expect(readSheets({ name: 'x.xlsx', bytes: new Uint8Array([1, 2, 3, 4, 5]) })).rejects.toThrow(ZipError);
    await expect(readSheets({ name: 'x.xls', bytes: new Uint8Array() })).rejects.toThrow(/xls/);
    const many = zipStore(Array.from({ length: 6 }, (_, i) => ({ name: `a${i}.xml`, data: new Uint8Array([1]) })));
    await expect(unzip(many, { maxEntries: 5, maxTotalBytes: 1e6 })).rejects.toThrow(/too many/);
    const bomb = new Uint8Array(deflateRawSync(new Uint8Array(5_000_000)));
    const nm = new TextEncoder().encode('xl/worksheets/sheet1.xml');
    const lh = new Uint8Array(30 + nm.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 8, true);
    lv.setUint16(26, nm.length, true);
    lh.set(nm, 30);
    const ch = new Uint8Array(46 + nm.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, bomb.length, true);
    cv.setUint32(24, 100, true); // lies about its size
    cv.setUint16(28, nm.length, true);
    ch.set(nm, 46);
    const eo = new Uint8Array(22);
    const ev = new DataView(eo.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(10, 1, true);
    ev.setUint32(12, ch.length, true);
    ev.setUint32(16, lh.length + bomb.length, true);
    const zip = new Uint8Array([...lh, ...bomb, ...ch, ...eo]);
    await expect(unzip(zip, { maxEntries: 10, maxTotalBytes: 1_000_000 })).rejects.toThrow(/unreasonable/);
  });
  it('crc32 matches the known check value', () => expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926));
  it('control characters are stripped from written text (Excel rejects them)', async () => {
    const sheets = await readXlsxSheets(xlsxBytes([['a\u0001b']]));
    expect(sheets[0]!.rows[0]).toEqual(['ab']);
  });
});

describe('price list parsing (legacy doImportItems row loop)', () => {
  it('maps headers by alias in any order and normalises codes', () => {
    expect(mapHeader(['Description', 'Item Code', 'Purchase UOM', 'Price per unit', 'Group', 'Sub group'])).toEqual({ name: 0, code: 1, uom: 2, price: 3, cat: 4, sub: 5 });
    expect(iCode('  prd1-4  230 ')).toBe('PRD1-4 230');
  });
  it('accepts valid rows; rejects bad unit / price; empty price keeps null; last duplicate wins; EXAMPLE skipped; junk labels dropped', () => {
    const r = parseItemRows([
      ['Code', 'Item Name', 'UOM', 'Price', 'Main Category', 'Sub Category'],
      ['a-1', 'Apple', 'kg', '2,5', 'Fresh', 'Fruit'],
      ['A-1', 'Apple v2', 'Gram', '0.003', 'Fresh', 'Fruit'],
      ['B-1', 'Box', 'Box', '', 'Non Food', 'Fis+A1:F663h'],
      ['C-1', 'Bad unit', 'furlong', '1', '', ''],
      ['C-2', 'Bad price', 'Gram', 'abc', '', ''],
      ['C-3', 'Neg', 'Gram', '-1', '', ''],
      ['EXAMPLE-9', 'x', 'Gram', '1', '', ''],
      ['', 'no code', 'Gram', '1', '', ''],
      ['D-1', 'Slice thing', 'slices', '0.5', 'F', 'G'],
    ]);
    expect(r.items.map((i) => [i.code, i.name, i.uom, i.price])).toEqual([
      ['A-1', 'Apple v2', 'Gram', 0.003],
      ['B-1', 'Box', 'Each', null],
      ['D-1', 'Slice thing', 'Slice', 0.5],
    ]);
    expect(r.fileDupes).toEqual({ 'A-1': 2 });
    expect(r.rejected).toHaveLength(3);
    expect(r.junk).toEqual(['B-1 sub group "Fis+A1:F663h"']);
    expect(r.items[1]!.sub).toBe('');
  });
  it('a file without a header uses the documented column order', () => {
    expect(parseItemRows([['X-1', 'Thing', 'Gram', '1.5', 'Cat', 'Sub']]).items[0]).toMatchObject({ code: 'X-1', price: 1.5, cat: 'Cat' });
  });
  it('iJunk recognises spreadsheet wreckage', () => {
    expect(iJunk('#REF!')).toBe(true);
    expect(iJunk('Fresh')).toBe(false);
    expect(iJunk('12:30')).toBe(true);
  });
  it('precision survives: 10-decimal prices parse exactly', () => {
    expect(parseItemRows([['X', 'n', 'Gram', '0.0000800001', '', '']]).items[0]!.price).toBe(0.0000800001);
  });
});

describe('recipe sheet parsing (flat template and kitchen block layout)', () => {
  const flat = (rows: string[][]) => parseRecipeSheets([{ name: 'Recipes', rows: [RTPL_HEAD, ...rows] }]);
  const row = (o: Record<string, string>) => RTPL_HEAD.map((h) => o[h] ?? '');

  it('groups rows into cards; a blank code continues the previous card; steps split on |; yield rule', () => {
    const p = flat([
      row({ Brand: 'GRM', 'Recipe Code': 'grm-mn-0100', 'Recipe Name': 'Dish', Category: 'Main', Type: 'Menu', Portions: '4', 'Batch Output': '500', 'Batch UOM': 'Gram', 'Sales Price': '12.5', 'Item Code': 'I-1', Qty: '100', Unit: 'g', 'Yield %': '75', 'Method Step': 'a | b', 'Waste %': '10', 'Card Buffer': '15' }),
      row({ 'Item Code': 'I-2', Qty: '2', Unit: 'pcs', 'Yield %': '', 'Method Step': 'c' }),
      row({ 'Item Code': 'I-3', Qty: '0' }), // dropped
      row({ 'Item Code': 'I-4', Qty: 'x' }), // dropped
      row({ 'Recipe Name': 'Second', Type: 'Sub-Recipe' }),
      row({ 'Item Code': 'I-5', Qty: '1,500', Unit: 'furlong' }),
    ]);
    expect(p.cards).toHaveLength(2);
    const [a, b] = p.cards;
    expect(a).toMatchObject({ brand: 'GRM', code: 'GRM-MN-0100', name: 'Dish', out: 4, bout: 500, buom: 'Gram', price: 12.5, buffer: 0.15, method: ['a', 'b', 'c'] });
    expect(a!.lines).toEqual([
      { code: 'I-1', qty: 100, unit: 'Gram', y: 0.75, yp: 10 },
      { code: 'I-2', qty: 2, unit: 'Each', y: 1, yp: null },
    ]);
    expect(b).toMatchObject({ name: 'Second', type: 'Sub-Recipe' });
    expect(b!.lines).toEqual([{ code: 'I-5', qty: 1500, unit: '', y: 1, yp: null }]);
    expect(p.warn).toHaveLength(2);
    expect(p.hasBrandColumn).toBe(true);
  });
  it('skips EXAMPLE rows and the example tab; no header = template order; nothing usable = empty', () => {
    expect(flat(recipeTplRows('FRS', 'GRM').map((r) => r.slice(0, 17))).cards).toHaveLength(0);
    expect(parseRecipeSheets([{ name: 'Example', rows: [RTPL_HEAD, row({ 'Recipe Code': 'X', 'Item Code': 'I', Qty: '1' })] }]).empty).toBe(true);
    const noHeader = parseRecipeSheets([{ name: 's', rows: [['GRM', 'GRM-MN-9', 'Salmon', 'Fish', 'Menu', '1', '', '', '', 'I-1', 'Ing', '5', 'Gram', '100', ''], ['', '', '', '', '', '', '', '', '', 'I-2', 'Ing2', '1', 'Gram', '100', '']] }]);
    expect(noHeader.cards[0]).toMatchObject({ code: 'GRM-MN-9', name: 'Salmon' });
    expect(parseRecipeSheets([]).empty).toBe(true);
  });
  it('rYield: blank 1, >1.5 is a percentage, capped at 1, junk 1', () => {
    expect([parseYield(''), parseYield('75'), parseYield('0.8'), parseYield('150'), parseYield('1.2'), parseYield('abc'), parseYield('-3')]).toEqual([1, 0.75, 0.8, 1, 1, 1, 1]);
  });
  it('card buffer: percent in the file; a bare fraction is read as a fraction', () => {
    expect(flat([row({ 'Recipe Name': 'A', 'Item Code': 'I', Qty: '1', 'Card Buffer': '20' })]).cards[0]!.buffer).toBe(0.2);
    expect(flat([row({ 'Recipe Name': 'A', 'Item Code': 'I', Qty: '1', 'Card Buffer': '0.2' })]).cards[0]!.buffer).toBe(0.2);
    expect(flat([row({ 'Recipe Name': 'A', 'Item Code': 'I', Qty: '1' })]).cards[0]!.buffer).toBeNull();
  });

  const blockSheet = (extra: unknown[][] = []) => [
    ['Chicken Salad', '', 'MD-001', '', 'PHOTO'],
    ['Net cost', '', '', 12],
    ['Selling price', '', '', 30],
    ['Output', '', '', 8, 'Gram'],
    ['Weight of dish', '', '', 250],
    ['Code', 'Item', '', '', '', 'UOM', 'QPG', 'PPG', 'Total'],
    ['PRD1-1', 'Onion', '', '', '', 'GM', '200', '0.003', ''],
    ['PRD1-2', 'Stock', '', '', '', 'Litre', '2', '0.01', ''],
    ['', 'no code', '', '', '', 'GM', '5', '', ''],
    ['PRD1-3', 'Zero', '', '', '', 'GM', '0', '', ''],
    ['A legend line with no quantity'],
    ...extra,
  ];
  it('detects a kitchen block sheet but never the flat template', () => {
    expect(blockHeaderRow(blockSheet())).toBe(5);
    expect(blockHeaderRow([RTPL_HEAD, ['a']])).toBe(-1);
  });
  it('converts a block sheet: title, label stack, kg/litre scaling, notes; prices in the file are ignored', () => {
    const { flat: f, meta } = blockConvert(blockSheet(), 'Tab', 5);
    expect(meta).toMatchObject({ name: 'Chicken Salad', code: 'MD-001', price: 30, out: 8, outUom: 'Gram', netcost: 12, dishwt: 250 });
    expect(f.map((x) => [x.icode, x.qty, x.unit, x.scaled])).toEqual([['PRD1-1', 200, 'Gram', false], ['PRD1-2', 2000, 'Ml', true]]);
    expect(meta.notes.join('|')).toMatch(/no item code/);
    expect(meta.notes.join('|')).toMatch(/quantity of 0/);
    expect(meta.notes.join('|')).toMatch(/Litre converted to Ml/);
    expect(f[0]).not.toHaveProperty('ppg');
  });
  it('one workbook can mix block tabs and the flat table; block lines carry the scaled marker; example tab skipped', () => {
    const p = parseRecipeSheets([
      { name: 'Example tab', rows: blockSheet() },
      { name: 'Salad', rows: blockSheet() },
      { name: 'Flat', rows: [RTPL_HEAD, row({ 'Recipe Name': 'Flat dish', 'Item Code': 'I-9', Qty: '3', Unit: 'Gram' })] },
    ]);
    expect(p.blocks).toHaveLength(1);
    expect(p.cards.map((c) => c.name)).toEqual(['Chicken Salad', 'Flat dish']);
    expect(p.cards[0]!.lines.map((l) => l.block)).toEqual([{ scaled: false }, { scaled: true }]);
    expect(p.cards[1]!.lines[0]!.block).toBeUndefined();
  });
  it('an unfilled template tab says nothing; a tab with lines but none usable is reported', () => {
    const empty = [...blockSheet().slice(0, 6)];
    expect(parseRecipeSheets([{ name: 'T', rows: empty }]).blocks).toHaveLength(0);
    const unusable = parseRecipeSheets([{ name: 'T', rows: [...empty, ['', 'x', '', '', '', 'GM', '1']] }]);
    expect(unusable.blocks[0]!.notes.join()).toMatch(/no usable ingredient line/);
  });
});
