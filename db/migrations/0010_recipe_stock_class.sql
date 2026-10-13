-- ISFC 0010 — stock class on recipe cards (D-97). Purely additive.
--
-- A label and filter only: 'Dry' or 'Raw' on a Menu card; NULL = not set. "Subrecipe" is never stored, it is derived from
-- recipe.type = 'SUB' in the screens. Costing, codes and the production sections do not read it. The legacy free-text
-- recipe.category is left exactly as it is (it drives the production sections, D-97).
ALTER TABLE recipe
  ADD COLUMN stock_class text,
  ADD CONSTRAINT recipe_stock_class_check CHECK (stock_class IS NULL OR stock_class IN ('Dry', 'Raw'));
