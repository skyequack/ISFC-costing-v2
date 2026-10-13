/** Units shared by the screens and the validators, so a unit the screen offers is one the server accepts (`ingredient.uom` CHECK). */
export const UNITS = ['Gram', 'Ml', 'Each', 'Slice'] as const;
/** Batch and sub-recipe outputs have no Slice. */
export const BATCH_UNITS = ['Gram', 'Ml', 'Each'] as const;
export type Unit = (typeof UNITS)[number];

/** D-97: the stored stock classes of a Menu card. 'Subrecipe' is derived from recipe.type = 'SUB' and never stored. */
export const STOCK_CLASSES = ['Dry', 'Raw'] as const;
export type StockClass = (typeof STOCK_CLASSES)[number];
