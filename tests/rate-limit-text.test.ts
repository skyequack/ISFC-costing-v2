import { describe, expect, it } from 'vitest';
import {
  pausedNote,
  restoreCheckNote,
  restoreCommitNote,
  stockCheckNote,
  stockCommitNote,
  tooManyText,
  waitPhrase,
} from '@/components/shared/rate-limit-text';

/** A fixed local clock: 2026-10-12 14:00:00 in the machine's time zone, so "(after HH:MM)" is predictable. */
const NOW = new Date(2026, 9, 12, 14, 0, 0);

describe('waitPhrase: how a wait is said (D-90, wording reviewed 2026-10-12)', () => {
  it.each([
    [1, 'a few seconds'],
    [2, 'a few seconds'],
    [15, 'a few seconds'],
    [16, 'about 20 seconds'],
    [40, 'about 40 seconds'],
    [41, 'about 45 seconds'],
    [59, 'about 60 seconds'],
    [60, 'about a minute'],
    [90, 'about a minute'],
    [119, 'about a minute'],
    [120, 'about 2 minutes'],
    [121, 'about 3 minutes'], // rounded up, never down
    [300, 'about 5 minutes'],
  ])('%i s is "%s"', (s, text) => expect(waitPhrase(s, NOW)).toBe(text));

  it('from 10 minutes up it adds the clock time the wait ends, so someone who walks away can check', () => {
    expect(waitPhrase(600, NOW)).toBe('about 10 minutes (after 14:10)');
    expect(waitPhrase(2400, NOW)).toBe('about 40 minutes (after 14:40)');
    expect(waitPhrase(3600, NOW)).toBe('about an hour (after 15:00)');
    expect(waitPhrase(3300, NOW)).toBe('about an hour (after 14:55)'); // 55 minutes or more is "an hour"
    expect(waitPhrase(3299, NOW)).toBe('about 55 minutes (after 14:55)');
  });

  it('crosses midnight with a plain HH:MM', () => {
    expect(waitPhrase(3600, new Date(2026, 9, 12, 23, 30, 0))).toBe('about an hour (after 00:30)');
  });

  it('never says zero or a negative wait', () => {
    expect(waitPhrase(0, NOW)).toBe('a few seconds');
    expect(waitPhrase(-5, NOW)).toBe('a few seconds');
  });
});

describe('the messages', () => {
  it('the plain refusal says tries (not requests), the real wait, and for accounts its own wording', () => {
    expect(tooManyText(90, false, NOW)).toBe('Too many tries in a short time. Try again in about a minute.');
    expect(tooManyText(2400, false, NOW)).toBe(
      'Too many tries in a short time. Try again in about 40 minutes (after 14:40).',
    );
    expect(tooManyText(undefined)).toBe('Too many tries in a short time. Try again shortly.');
    expect(tooManyText(3600, true, NOW)).toBe(
      'Too many account changes in a short time. Try again in about an hour (after 15:00).',
    );
  });

  it('dialog notes say nothing was lost and name the button the user will press', () => {
    expect(restoreCommitNote(600, NOW)).toBe(
      'Too many tries in a short time. Nothing was changed – wait about 10 minutes (after 14:10), then press Restore again.',
    );
    expect(stockCommitNote(600, NOW)).toBe(
      'Too many tries in a short time. Nothing was loaded and your file is still here – wait about 10 minutes (after 14:10), then press Load again.',
    );
    expect(restoreCheckNote(45, NOW)).toBe(
      'Too many tries in a short time. Nothing was changed – choose the file again in about 45 seconds.',
    );
    expect(stockCheckNote(45, NOW)).toBe(
      'Too many tries in a short time. Your file is fine – choose it again in about 45 seconds.',
    );
    expect(pausedNote(8, NOW)).toBe('Paused – continuing by itself in a few seconds. Keep this page open…');
  });

  it('without a Retry-After the notes still tell the user what to do', () => {
    expect(restoreCommitNote()).toContain('wait a moment, then press Restore again');
    expect(stockCommitNote()).toContain('wait a moment, then press Load again');
  });
});
