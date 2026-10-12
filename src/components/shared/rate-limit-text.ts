/**
 * Every string the browser shows when the server answers 429 (D-90). One module so the wording is reviewed in one place.
 * Wording and the wait rule follow the review of 2026-10-12 recorded in D-90: plain "tries" (not "requests"), a real wait
 * (Retry-After can be a minute, ten minutes or an hour), and a clear "nothing was lost".
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The wait as a phrase that fits after "in" or "wait": "a few seconds", "about 20 seconds", "about a minute",
 * "about 5 minutes", "about an hour". From 10 minutes up the local clock time is added so someone who walks away can check
 * it: "about 40 minutes (after 14:35)". Rounded up, never down.
 */
export function waitPhrase(seconds: number, now: Date = new Date()): string {
  const s = Math.max(1, Math.ceil(seconds));
  let t: string;
  if (s <= 15) t = 'a few seconds';
  else if (s < 60) t = `about ${Math.ceil(s / 5) * 5} seconds`;
  else if (s < 120) t = 'about a minute';
  else if (s < 3300) t = `about ${Math.ceil(s / 60)} minutes`;
  else t = 'about an hour';
  if (s >= 600) {
    // rounded UP to the minute: trying a few seconds before the stated time must not be refused again
    const at = new Date(Math.ceil((now.getTime() + s * 1000) / 60_000) * 60_000);
    t += ` (after ${pad2(at.getHours())}:${pad2(at.getMinutes())})`;
  }
  return t;
}

const TOO_MANY = 'Too many tries in a short time.';

/** The message for a refused request. `accounts` = invites, role changes, bans (their own wording, never retried by itself). */
export function tooManyText(retryAfter: number | undefined, accounts = false, now?: Date): string {
  const lead = accounts ? 'Too many account changes in a short time.' : TOO_MANY;
  return retryAfter ? `${lead} Try again in ${waitPhrase(retryAfter, now)}.` : `${lead} Try again shortly.`;
}

/** Inline note in the restore review dialog after a refused commit: the uploaded backup is kept, the same button works again. */
export const restoreCommitNote = (retryAfter?: number, now?: Date) =>
  `${TOO_MANY} Nothing was changed – wait ${retryAfter ? waitPhrase(retryAfter, now) : 'a moment'}, then press Restore again.`;

/** Inline note in the stock-import review dialog after a refused commit: the parsed file is kept in the browser. */
export const stockCommitNote = (retryAfter?: number, now?: Date) =>
  `${TOO_MANY} Nothing was loaded and your file is still here – wait ${retryAfter ? waitPhrase(retryAfter, now) : 'a moment'}, then press Load again.`;

/** Restore refused at the check step (no Restore button exists yet), so the user is told to pick the file again. */
export const restoreCheckNote = (retryAfter?: number, now?: Date) =>
  `${TOO_MANY} Nothing was changed – choose the file again ${retryAfter ? `in ${waitPhrase(retryAfter, now)}` : 'in a moment'}.`;

/** Stock import refused at the check step. Title "Please wait"; the file itself is fine. */
export const STOCK_CHECK_TITLE = 'Please wait';
export const stockCheckNote = (retryAfter?: number, now?: Date) =>
  `${TOO_MANY} Your file is fine – choose it again ${retryAfter ? `in ${waitPhrase(retryAfter, now)}` : 'in a moment'}.`;

/** Shown in the restore dialog while the one automatic retry waits; stays on screen for the whole wait. */
export const pausedNote = (seconds: number, now?: Date) =>
  `Paused – continuing by itself in ${waitPhrase(seconds, now)}. Keep this page open…`;

/** Toast for the one automatic retry anywhere else (imports, uploads, downloads, paged backup). */
export const WAITING_TOAST = 'Waiting a few seconds, then trying again…';

/** Toasts that start with this stay up longer than the usual 2.2 s: a non-native reader needs time to read them. */
export const LONG_TOAST_PREFIX = 'Too many ';
export const LONG_TOAST_MS = 8000;

/** Window event the API client sends when it waits for its one automatic retry and the caller gave no `onWait`. */
export const RATE_WAIT_EVENT = 'isfc:rate-wait';
