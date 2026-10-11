-- ISFC 0007 — three-stage line yield (D-70, D-85). Purely additive.
--
-- A line may carry up to three stage yields (thawing, cutting/trimming, cooking) as fractions (0.9 = 90%). `y` stays the one
-- yield costing, requisition and every export read: while any stage is set the service writes y = thaw x cut x cook (a blank
-- stage counts as 1), so nothing downstream changes and a line with no stages behaves exactly as before. NULL is "not set",
-- never 0. Each stage is NULL or in (0, 10], the same range costing accepts for y.
ALTER TABLE recipe_line
  ADD COLUMN y_thaw double precision,
  ADD COLUMN y_cut  double precision,
  ADD COLUMN y_cook double precision,
  ADD CONSTRAINT recipe_line_stage_range CHECK (
    (y_thaw IS NULL OR (y_thaw > 0 AND y_thaw <= 10)) AND
    (y_cut  IS NULL OR (y_cut  > 0 AND y_cut  <= 10)) AND
    (y_cook IS NULL OR (y_cook > 0 AND y_cook <= 10))
  );
