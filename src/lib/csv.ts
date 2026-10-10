/**
 * CSV cell writer (legacy csvEsc 1515) plus D-36: a text cell that starts with = + - @ (or a tab / CR) is neutralised
 * with a leading apostrophe so a spreadsheet cannot run it as a formula. Numbers are written as text, never altered.
 */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  // a lone '-' is the "not set" marker (production export site column), not a formula
  if (typeof v === 'string' && s !== '-' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export const csvLine = (cells: unknown[]): string => cells.map(csvCell).join(',');
