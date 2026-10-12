/** Units shared by the screens and the validators, so a unit the screen offers is one the server accepts (`ingredient.uom` CHECK). */
export const UNITS = ['Gram', 'Ml', 'Each', 'Slice'] as const;
/** Batch and sub-recipe outputs have no Slice. */
export const BATCH_UNITS = ['Gram', 'Ml', 'Each'] as const;
export type Unit = (typeof UNITS)[number];
