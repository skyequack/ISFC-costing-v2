import { z } from 'zod';
import { stagedYield, validYield } from '@/domain/recipes/yield-stages';
import { BATCH_UNITS, STOCK_CLASSES, UNITS } from '@/lib/units';

const trimmed = (max: number) => z.string().trim().max(max);

export const idStr = z.string().min(1).max(64);
/** Codes: trimmed, no control characters, <= 60. */
export const codeStr = trimmed(60).refine((s) => !/[\u0000-\u001f]/.test(s), 'invalid characters');

/** One stage of the three-stage yield (D-70): a fraction in (0,10]; null or absent = not set. */
const stageIn = z.number().finite().gt(0).max(10).nullable().optional();

/**
 * A raw material's default stage (D-93): a fraction in (0,10]. A typed 0 means "100%" and is stored as null (never 0);
 * null clears it; absent = leave it as it is (an old client or a price-only edit must not wipe the defaults).
 */
export const itemStageIn = z.preprocess((v) => (v === 0 ? null : v), stageIn);

export const lineIn = z
  .object({
    code: codeStr, // '' = blank row
    qty: z.number().finite().min(0).max(1e9),
    unit: z.enum(UNITS),
    y: z.number().finite().default(1),
    yp: z.number().finite().min(0).max(1000).nullable().default(null),
    yThaw: stageIn,
    yCut: stageIn,
    yCook: stageIn,
  })
  .superRefine((l, ctx) => {
    // the stages multiply into the line's yield, which costing only accepts in (0,10]: refuse rather than read it as 1
    const p = stagedYield(l);
    if (p !== null && !validYield(p))
      ctx.addIssue({
        code: 'custom',
        path: ['yCook'],
        message: 'The three stages together must give a yield above 0 and up to 1000%',
      });
  });
export type LineIn = z.output<typeof lineIn>;

/** D-36: a line yield outside (0,10] is normalised to 1, exactly as the costing engine treats it. */
export function normY(y: number): number {
  return y > 0 && y <= 10 ? y : 1;
}

export const recipeSaveIn = z.object({
  version: z.number().int().min(0),
  code: codeStr.min(1).optional(),
  /** Legacy regenCode (2880): allocate the next free auto code for the card's brand and type. */
  regenCode: z.boolean().optional(),
  name: trimmed(200).optional(),
  category: trimmed(100).optional(),
  /** D-97: Dry/Raw, or null to clear. Ignored (cleared) on a Sub-Recipe: 'Subrecipe' is derived from the type. */
  stockClass: z.enum(STOCK_CLASSES).nullable().optional(),
  type: z.enum(['MENU', 'SUB']).optional(),
  brandId: idStr.optional(),
  output: z.number().finite().gt(0).max(1e6).optional(),
  subQty: z.number().finite().min(0).max(1e9).optional(),
  subUom: z.enum(BATCH_UNITS).optional(),
  batchOut: z.number().finite().min(0).max(1e9).optional(),
  batchUom: z.enum(BATCH_UNITS).optional(),
  sellingPrice: z.number().finite().min(0).max(1e7).optional(),
  buffer: z.number().finite().min(0).max(10).nullable().optional(),
  lines: z.array(lineIn).max(500).optional(),
  method: z.array(z.string().max(2000)).max(200).optional(),
});
export type RecipeSaveIn = z.output<typeof recipeSaveIn>;

export const recipeCreateIn = z.object({
  brandId: idStr,
  type: z.enum(['MENU', 'SUB']).default('MENU'),
  name: trimmed(200).optional(),
  category: trimmed(100).optional(),
});

export const ingredientIn = z.object({
  code: codeStr.min(1),
  name: trimmed(300).min(1),
  uom: z.enum(UNITS),
  price: z.number().finite().min(0).max(1e9).nullable(),
  category: trimmed(100).default(''),
  subcategory: trimmed(100).default(''),
  flag: trimmed(500).default(''),
  brandIds: z.array(idStr).max(40).default([]),
  yThaw: itemStageIn,
  yCut: itemStageIn,
  yCook: itemStageIn,
});
export type IngredientIn = z.output<typeof ingredientIn>;
