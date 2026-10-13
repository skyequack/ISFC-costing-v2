-- ISFC 0012 — dated ingredient prices (D-100, slice B2). Purely additive.
--
-- A price takes effect on the business day it is saved (Asia/Riyadh, no backdating, no future dates), so every row gets
-- `effective_on` = that day. Existing rows are backfilled from the day they were written. The last row of a day wins for
-- that whole day (rows keep their created_at order). Nothing reads `effective_on` for costing yet (that is B3), so every
-- current figure is unchanged. `ingredient.price` stays the current price; the newest history row should equal it.
ALTER TABLE ingredient_price_history
  ADD COLUMN effective_on date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Riyadh')::date);
UPDATE ingredient_price_history SET effective_on = (created_at AT TIME ZONE 'Asia/Riyadh')::date;
DROP INDEX ingredient_price_history_idx;
CREATE INDEX ingredient_price_history_idx ON ingredient_price_history (ingredient_id, effective_on, created_at);
