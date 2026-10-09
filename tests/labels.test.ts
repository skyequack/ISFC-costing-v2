import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { NAV, TITLES } from '@/lib/nav';

/**
 * D-41: no UI wording changes except the Backup subtitle. The legacy NAV and TITLES are evaluated from the frozen file and
 * compared with the ported ones, so any accidental edit of a label fails here.
 */
const legacy = fs.readFileSync(path.resolve(__dirname, '../legacy/app.html'), 'utf8').split('\n');
const sandbox: Record<string, unknown> = {};
vm.runInNewContext(
  `${legacy.slice(1531, 1550).join('\n')}\n${legacy.slice(1600, 1617).join('\n')}\nthis.NAV = NAV; this.TITLES = TITLES;`,
  sandbox,
);
const LNAV = sandbox.NAV as string[][];
const LTITLES = sandbox.TITLES as Record<string, [string, string]>;

describe('labels stay verbatim (D-41)', () => {
  it('navigation groups and entries match the legacy NAV', () => {
    const ported = NAV.map((n) => ('group' in n ? ['g', n.group] : [n.route, n.label, n.icon]));
    expect(ported).toEqual(LNAV.map((n) => (n[0] === 'g' ? ['g', n[1]] : [n[0], n[1], n[2]])));
  });
  it('screen titles and subtitles match the legacy TITLES except the Backup subtitle', () => {
    const { backup: ported, ...rest } = TITLES;
    const { backup: legacyBackup, ...legacyRest } = LTITLES;
    expect(rest).toEqual(legacyRest);
    expect(legacyBackup).toEqual(['Backup & Export', 'Your data lives in this browser - back it up']);
    expect(ported).toEqual([
      'Backup & Export',
      'Your data is stored securely in the database. Download a backup copy at any time.',
    ]);
  });
});
