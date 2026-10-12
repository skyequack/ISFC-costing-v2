// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls, installFetch, nav, onFetch, renderInShell, resetFetch } from './harness';

vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh }),
}));
vi.mock('@clerk/nextjs', () => ({ useClerk: () => ({ signOut: vi.fn() }) }));

import { BackupScreen } from '@/components/screens/BackupScreen';
import { api, errText, fetchRetry } from '@/components/shared/api-client';

const saved = vi.hoisted(() => ({ names: [] as string[] }));

beforeAll(() => {
  installFetch();
  window.scrollTo = vi.fn();
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.names.push(this.download);
  });
});
beforeEach(() => {
  resetFetch();
  saved.names.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const refuse = (retryAfter: number | null) => ({
  status: 429,
  json: { error: { code: 'rate_limited', message: 'Too many tries in a short time. Try again shortly.' } },
  headers: retryAfter === null ? {} : { 'retry-after': String(retryAfter) },
});
const hits = (url: string) => calls.filter((c) => c.url.startsWith(url));

describe('api(): the one automatic retry (D-90)', () => {
  it('waits out a short refusal and sends the request once more, then returns the answer', async () => {
    vi.useFakeTimers();
    let n = 0;
    onFetch((c) => (c.url === '/api/thing' && ++n === 1 ? refuse(2) : { json: { ok: true } }));
    const p = api('GET', '/api/thing');
    await vi.advanceTimersByTimeAsync(1999);
    expect(hits('/api/thing')).toHaveLength(1); // still waiting
    await vi.advanceTimersByTimeAsync(2);
    await expect(p).resolves.toEqual({ ok: true });
    expect(hits('/api/thing')).toHaveLength(2);
  });

  it('tells the caller when it starts waiting (or sends the window event the toast listens to)', async () => {
    vi.useFakeTimers();
    let n = 0;
    onFetch((c) => (c.url === '/api/a' && ++n === 1 ? refuse(3) : { json: {} }));
    const waits: number[] = [];
    const p1 = api('GET', '/api/a', undefined, { onWait: (s) => waits.push(s) });
    await vi.advanceTimersByTimeAsync(3100);
    await p1;
    expect(waits).toEqual([3]);

    n = 0;
    const events: number[] = [];
    window.addEventListener('isfc:rate-wait', (e) => events.push((e as CustomEvent).detail.seconds));
    const p2 = api('GET', '/api/a');
    await vi.advanceTimersByTimeAsync(3100);
    await p2;
    expect(events).toEqual([3]);
  });

  it('retries only once: a second refusal is shown, with the wait', async () => {
    vi.useFakeTimers();
    onFetch((c) => (c.url === '/api/thing' ? refuse(5) : undefined));
    const p = api('GET', '/api/thing').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(6000);
    const err = await p;
    expect(hits('/api/thing')).toHaveLength(2);
    expect(errText(err)).toBe('Too many tries in a short time. Try again in a few seconds.');
  });

  it('a long wait is not waited out: one call, and the message names the real wait', async () => {
    onFetch(() => refuse(600));
    const err = await api('POST', '/api/import/restore?mode=commit', {}).catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(errText(err)).toMatch(
      /^Too many tries in a short time\. Try again in about 10 minutes \(after \d\d:\d\d\)\.$/,
    );
  });

  it('a refusal with no Retry-After is not retried and says "shortly"', async () => {
    onFetch(() => refuse(null));
    const err = await api('GET', '/api/thing').catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(errText(err)).toBe('Too many tries in a short time. Try again shortly.');
  });

  it('invites, role changes and bans are never retried by themselves, and have their own wording', async () => {
    onFetch(() => refuse(2));
    const err = await api('POST', '/api/users/invite', { email: 'a@b.c' }).catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(errText(err)).toBe('Too many account changes in a short time. Try again in a few seconds.');
  });

  it('other errors are untouched: the server message comes through as before', async () => {
    onFetch(() => ({ status: 409, json: { error: { code: 'conflict', message: 'Code already exists' } } }));
    const err = await api('POST', '/api/recipes', {}).catch((e: unknown) => e);
    expect(errText(err)).toBe('Code already exists');
    expect(calls).toHaveLength(1);
  });

  it('fetchRetry returns the second answer as it is, so a download can show it', async () => {
    vi.useFakeTimers();
    onFetch(() => refuse(1));
    const p = fetchRetry('/api/export/recipes');
    await vi.advanceTimersByTimeAsync(1100);
    expect((await p).status).toBe(429);
  });
});

const counts = { items: 3, recipes: 2, conv: 1, photos: 0, photoKb: 0 };

describe('exports download through fetch, so a refusal is a message and not a page of JSON (D-90)', () => {
  it('the backup screen CSV download saves the file under the name the server gave', async () => {
    onFetch((c) =>
      c.url === '/api/export/recipes'
        ? { json: {}, headers: { 'content-disposition': 'attachment; filename="ISFC-recipe-costing.csv"' } }
        : undefined,
    );
    renderInShell(<BackupScreen counts={counts} sites={['NIC']} />, 'gm');
    fireEvent.click(screen.getByText('Recipe costing summary (CSV)'));
    await waitFor(() => expect(saved.names).toEqual(['ISFC-recipe-costing.csv']));
    expect(await screen.findByText('Download started')).toBeTruthy();
  });

  it('a refused download shows the message and the screen stays', async () => {
    onFetch(() => refuse(600));
    renderInShell(<BackupScreen counts={counts} sites={['NIC']} />, 'gm');
    fireEvent.click(screen.getByText('Recipe costing summary (CSV)'));
    expect(await screen.findByText(/^Too many tries in a short time\. Try again in about 10 minutes/)).toBeTruthy();
    expect(saved.names).toHaveLength(0);
    expect(screen.getByText('Import templates')).toBeTruthy(); // still on the Backup & Export screen
  });
});

describe('restore (D-90)', () => {
  const backupText = JSON.stringify({ format: 'isfc-backup', version: 1, items: [] });
  const stats = {
    recipes: { added: 1, updated: 2, removed: 0 },
    ingredients: { added: 0, updated: 3, keptNotInBackup: 0 },
    brands: { added: 0, updated: 1 },
    menus: { added: 0, updated: 0, deactivated: 0 },
    menuPax: 0,
    production: 0,
  };
  const pick = () => {
    const input = document.querySelector('input[type=file][accept=".json"]') as HTMLInputElement;
    const file = new File([backupText], 'backup.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => backupText });
    fireEvent.change(input, { target: { files: [file] } });
  };
  beforeAll(() => {
    if (!globalThis.crypto?.randomUUID) vi.stubGlobal('crypto', { randomUUID: () => 'session-1' });
  });

  it('a refused commit keeps the dialog and the uploaded backup; the same button works again', async () => {
    let commits = 0;
    onFetch((c) => {
      if (c.url.includes('/restore/chunk')) return { json: {} };
      if (c.url.includes('mode=dry-run')) return { json: { stats } };
      if (c.url.includes('mode=commit')) return ++commits === 1 ? refuse(600) : { json: { stats } };
      return undefined;
    });
    renderInShell(<BackupScreen counts={counts} sites={['NIC']} />, 'gm');
    pick();
    expect(await screen.findByText('Restore from this backup?')).toBeTruthy();
    fireEvent.click(screen.getByText('Restore'));
    const note = await screen.findByRole('alert');
    expect(note.textContent).toMatch(
      /^Too many tries in a short time\. Nothing was changed – wait about 10 minutes \(after \d\d:\d\d\), then press Restore again\.$/,
    );
    expect(screen.getByText('Restore from this backup?')).toBeTruthy(); // the dialog stayed
    fireEvent.click(screen.getByText('Restore'));
    await waitFor(() => expect(hits('/api/import/restore?mode=commit')).toHaveLength(2));
    expect(hits('/api/import/restore?mode=commit')[1]!.body).toEqual(hits('/api/import/restore?mode=commit')[0]!.body);
    expect(hits('/api/import/restore/chunk')).toHaveLength(1); // the backup was not uploaded again
    expect(await screen.findByText('Backup restored')).toBeTruthy();
  });

  it('refused while checking the file: the dialog says nothing was changed and to choose the file again', async () => {
    onFetch((c) => (c.url.includes('/restore/chunk') ? refuse(600) : undefined));
    renderInShell(<BackupScreen counts={counts} sites={['NIC']} />, 'gm');
    pick();
    expect(await screen.findByText('Could not restore')).toBeTruthy();
    expect(screen.getByText(/Nothing was changed – choose the file again in about 10 minutes/)).toBeTruthy();
  });

  it('a short refusal in the middle of the upload pauses with a note on screen, then carries on by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let chunk = 0;
    onFetch((c) => {
      if (c.url.includes('/restore/chunk')) return ++chunk === 1 ? refuse(4) : { json: {} };
      if (c.url.includes('mode=dry-run')) return { json: { stats } };
      return undefined;
    });
    renderInShell(<BackupScreen counts={counts} sites={['NIC']} />, 'gm');
    pick();
    expect(
      await screen.findByText(/^Paused – continuing by itself in a few seconds\. Keep this page open…$/),
    ).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    expect(await screen.findByText('Restore from this backup?')).toBeTruthy();
    expect(hits('/api/import/restore/chunk')).toHaveLength(2); // refused once, sent again
  });
});
