/** Units shared by the screens and the validators, so a unit the screen offers is one the server accepts (`ingredient.uom` CHECK). */
export const UNITS = ['Gram', 'Ml', 'Each', 'Slice'] as const;
/** Batch and sub-recipe outputs have no Slice. */
export const BATCH_UNITS = ['Gram', 'Ml', 'Each'] as const;
export type Unit = (typeof UNITS)[number];

/** D-97: the stored stock classes of a Menu card. 'Subrecipe' is derived from recipe.type = 'SUB' and never stored. */
export const STOCK_CLASSES = ['Dry', 'Raw'] as const;
export type StockClass = (typeof STOCK_CLASSES)[number];

/** D-102: how a base unit (`ingredient.uom`) is classed; a fixed unit (Kg, L) fits only an item of the same kind. */
export type UnitKind = 'mass' | 'volume' | 'each' | 'slice' | 'pack';
export interface UnitDef {
  code: string;
  kind: UnitKind;
  /** base units in one of this unit; null for a pack unit, whose factor is entered per item */
  toBase: number | null;
}
const BASE_KIND: Record<Unit, UnitKind> = { Gram: 'mass', Ml: 'volume', Each: 'each', Slice: 'slice' };
/** Factor bounds for a pack unit entered per item. */
export const PACK_FACTOR_MIN = 1e-6;
export const PACK_FACTOR_MAX = 1e6;

export type UnitFit = { ok: true; factor: number } | { ok: false; message: string };

/**
 * Whether `unit` can be the purchase/inventory unit of an item priced in `uom`, and its factor (base units per one `unit`).
 * A fixed unit takes the table's factor and refuses a different kind (no density is ever guessed); a pack unit needs a
 * finite factor in [1e-6, 1e6]. A unit equal to the base unit is always factor 1.
 */
export function fitUnit(unit: UnitDef, uom: Unit, factor: number | null | undefined): UnitFit {
  if (unit.code.toLowerCase() === uom.toLowerCase()) return { ok: true, factor: 1 };
  if (unit.kind === 'pack') {
    if (typeof factor !== 'number' || !isFinite(factor) || factor < PACK_FACTOR_MIN || factor > PACK_FACTOR_MAX)
      return { ok: false, message: `Enter how many ${uom} one ${unit.code} holds, as a number above zero` };
    return { ok: true, factor };
  }
  if (unit.kind !== BASE_KIND[uom] || unit.toBase === null)
    return { ok: false, message: `${unit.code} cannot be used for an item counted in ${uom}` };
  return { ok: true, factor: unit.toBase };
}

/** Quantity in an item's own unit to base units, and back. Not bit-exact for factors like 1/3; round only at display. */
export const toBase = (qty: number, factor: number): number => qty * factor;
export const fromBase = (qty: number, factor: number): number => qty / factor;
