-- ISFC 0009 — default yield stages per raw material (D-93). Purely additive.
--
-- A raw material may carry a default thawing, cutting/trimming and cooking yield as fractions (0.9 = 90%). They are only a
-- source that prefills NEW recipe lines (D-94); costing never reads them, the line keeps its own copy (recipe_line.y_*, 0007).
-- NULL = no default = treated as 100%. A typed 0 or blank is stored as NULL, never 0. Each stage is NULL or in (0, 10], the
-- same range as recipe_line.
ALTER TABLE ingredient
  ADD COLUMN y_thaw double precision,
  ADD COLUMN y_cut  double precision,
  ADD COLUMN y_cook double precision,
  ADD CONSTRAINT ingredient_stage_range CHECK (
    (y_thaw IS NULL OR (y_thaw > 0 AND y_thaw <= 10)) AND
    (y_cut  IS NULL OR (y_cut  > 0 AND y_cut  <= 10)) AND
    (y_cook IS NULL OR (y_cook > 0 AND y_cook <= 10))
  );
