/**
 * Rate-limit classes and budgets (D-88). One fixed window per class, per user. These are starting values: tune them here.
 * They sit about 2x above what the real clients send (see tests/rate-limit-budgets.test.ts, which replays those counts), and
 * the upload / import / mutation numbers are doubled again because some kitchens share a login.
 *
 * `failClosed` (D-89): when the counter store errors or times out, these classes refuse the request (the routes need the
 * database anyway); every other class lets it through and logs a warning, so a kitchen save is never blocked by the limiter.
 */
export interface RateRule {
  windowSec: number;
  budget: number;
  failClosed: boolean;
}

export const RATE_RULES = {
  /** GET /api/export/backup, called once per page of the full backup */
  export_backup: { windowSec: 600, budget: 400, failClosed: false },
  /** GET /api/export/[kind], including the stock template downloads */
  export_kind: { windowSec: 60, budget: 30, failClosed: false },
  /** POST /api/import/restore/chunk */
  restore_chunk: { windowSec: 600, budget: 150, failClosed: true },
  /** POST /api/import/restore, dry-run and commit share this budget */
  restore: { windowSec: 600, budget: 10, failClosed: true },
  /** stock, price-list and recipe uploads share one budget */
  import: { windowSec: 600, budget: 240, failClosed: false },
  /** recipe photo and brand logo PUT / DELETE */
  upload: { windowSec: 60, budget: 60, failClosed: false },
  /** POST /api/recipes/[id]/revisions: Start new revision (each one copies the whole card) */
  revision: { windowSec: 600, budget: 60, failClosed: false },
  /** invite, edit/revoke invite, role change, delete, ban, unban (Clerk API + email) */
  user_admin: { windowSec: 3600, budget: 40, failClosed: true },
  /** add / edit / delete brand, archive the activity log */
  admin_write: { windowSec: 600, budget: 120, failClosed: false },
} as const satisfies Record<string, RateRule>;

export type RateClass = keyof typeof RATE_RULES;
