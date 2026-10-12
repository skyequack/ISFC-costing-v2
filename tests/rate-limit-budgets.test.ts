import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/errors';
import {
  IMAGE_CHUNK_BYTES,
  ITEM_IMPORT_PART,
  RECIPE_PART_CARDS,
  RECIPE_PART_LINES,
  RESTORE_SLICE_CHARS,
} from '@/lib/io-limits';
import { RATE_RULES, type RateClass } from '@/lib/rate-limit/budgets';
import { checkRate } from '@/lib/rate-limit/limiter';
import { STOCK_PAGE } from '@/lib/services/backup';
import { fakeRateStore } from './helpers/rate-store';

vi.mock('@/lib/logger', () => ({ log: vi.fn() }));

/**
 * D-88: the budgets must not get in the way of real work. These replay the request counts of the real flows at ZERO delay
 * (the worst case: everything lands in one window), with the counts derived from the constants the browser code uses
 * (src/lib/io-limits.ts, STOCK_PAGE), so changing a chunk or page size fails here and not for a user.
 */
const CLOCK = 7_200_000; // a multiple of every window length, so each window starts exactly here

/** Send `n` requests of one class from one user in one window; returns how many were refused. */
async function refusedOf(cls: RateClass, n: number, user = 'u1'): Promise<number> {
  const store = fakeRateStore({ now: CLOCK });
  let refused = 0;
  for (let i = 0; i < n; i++) {
    try {
      await checkRate(store, user, cls);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) refused++;
      else throw e;
    }
  }
  return refused;
}

const b64 = (raw: number) => Math.ceil((raw * 4) / 3);
/** the browser downsizes a dish photo to about 300 KB (D-49); the 1.5 MB server cap is never the normal case */
const PHOTO_B64 = b64(300_000);

describe('the budgets leave room for the real flows (D-88)', () => {
  it("a full backup of a system three times today's size (1000 photos, 500k count rows, 500k receipts)", async () => {
    const perRequest = Math.max(1, Math.min(50, Math.floor(IMAGE_CHUNK_BYTES / PHOTO_B64)));
    const photoRequests = Math.ceil(1000 / perRequest);
    const stockRequests = Math.ceil(500_000 / STOCK_PAGE) * 2;
    const requests = 1 /* core */ + photoRequests + 1 /* logos */ + stockRequests;
    expect(requests).toBeLessThan(RATE_RULES.export_backup.budget / 1.5); // at least 1.5x headroom
    expect(await refusedOf('export_backup', requests)).toBe(0);
    expect(await refusedOf('export_backup', RATE_RULES.export_backup.budget + 1)).toBe(1); // and it is a real ceiling
  });

  it("a restore of a backup that carries every card's photo (321 cards x 300 KB): chunks, then dry-run, then commit", async () => {
    const text = 1_000_000 + 321 * PHOTO_B64; // the JSON text the browser slices
    const chunks = Math.ceil(text / RESTORE_SLICE_CHARS);
    expect(chunks).toBeLessThan(RATE_RULES.restore_chunk.budget / 1.3); // at least 1.3x headroom
    expect(await refusedOf('restore_chunk', chunks)).toBe(0);
    expect(await refusedOf('restore', 2)).toBe(0); // dry-run + commit
    expect(await refusedOf('restore', 4)).toBe(0); // and a second attempt after fixing a refused backup (D-56)
    expect(await refusedOf('restore', RATE_RULES.restore.budget + 1)).toBe(1);
  });

  it('the largest restore one window allows is stated, so a bigger backup is a known limit and not a surprise', () => {
    const maxChars = RATE_RULES.restore_chunk.budget * RESTORE_SLICE_CHARS;
    expect(maxChars).toBeGreaterThanOrEqual(150_000_000); // about 110 MB of photos once base64-encoded
  });

  it('a 5000-row price list, the 321 recipe cards and a stock file, each uploaded twice (dry-run + commit, then again after a fix)', async () => {
    const priceParts = Math.ceil(5000 / ITEM_IMPORT_PART);
    const recipeParts = Math.max(Math.ceil(321 / RECIPE_PART_CARDS), Math.ceil(7321 / RECIPE_PART_LINES));
    const oneRound = priceParts * 2 + recipeParts * 2 + 2; // dry-run and commit of each; the stock file is one of each
    const requests = oneRound * 2;
    expect(requests).toBeLessThan(RATE_RULES.import.budget / 2); // at least 2x headroom (shared kitchen logins)
    expect(await refusedOf('import', requests)).toBe(0);
  });

  it('onboarding a site: 60 dish photos in one minute pass, and the 61st is refused', async () => {
    expect(await refusedOf('upload', 60)).toBe(0);
    expect(await refusedOf('upload', 61)).toBe(1);
  });

  it('a month-end close: 15 exports in a minute pass; a runaway script is stopped at 30', async () => {
    expect(await refusedOf('export_kind', 15)).toBe(0);
    expect(await refusedOf('export_kind', 31)).toBe(1);
  });

  it('onboarding a brigade: 15 invites and 15 role changes in an hour pass; 41 is refused', async () => {
    expect(await refusedOf('user_admin', 30)).toBe(0);
    expect(await refusedOf('user_admin', 41)).toBe(1);
  });

  it('adding a brand and logos never meets the admin budget in normal use', async () => {
    expect(await refusedOf('admin_write', 30)).toBe(0);
  });
});
