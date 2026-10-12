/**
 * Sizes of the requests the browser sends in parts (import, restore, backup). They live here so the rate-limit budgets
 * (src/lib/rate-limit/budgets.ts, D-88) can be checked against them: tests/rate-limit-budgets.test.ts replays the request
 * counts these sizes produce, so changing one fails that test instead of locking a user out in production.
 */
/** characters per restore upload slice (the server limit is 1.5 MB) */
export const RESTORE_SLICE_CHARS = 1_200_000;
/** price-list rows per import request */
export const ITEM_IMPORT_PART = 500;
/** recipe cards per import request, or this many lines, whichever comes first */
export const RECIPE_PART_CARDS = 40;
export const RECIPE_PART_LINES = 1000;
/** bytes of base64 images per backup response, at most 50 images */
export const IMAGE_CHUNK_BYTES = 3_000_000;
