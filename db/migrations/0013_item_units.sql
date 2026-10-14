-- ISFC 0013 — three units per raw material (D-102, D-103). Purely additive; costing never reads any of it.
--
-- `ingredient.uom` (Gram/Ml/Each/Slice) stays the costing unit and the price stays per base unit. A raw material also has a
-- purchase unit and an inventory unit, each with a factor = how many BASE units one of that unit holds (a Carton of 12 000 Gram
-- = 12000). The cooking unit is the existing unit_conversion row. NULL unit and factor (together) = the base unit, factor 1.
--
-- `unit` is the list the Items form offers. kind: a fixed unit (to_base set) may only be used on an item whose base unit has the
-- same kind (Kg on a Gram item = 1000); a 'pack' unit (to_base NULL) takes the factor entered per item.
CREATE TABLE unit (
  code       text PRIMARY KEY CHECK (length(code) BETWEEN 1 AND 16 AND code = btrim(code)),
  kind       text NOT NULL CHECK (kind IN ('mass','volume','each','slice','pack')),
  to_base    double precision CHECK (to_base IS NULL OR (to_base > 0 AND to_base < 'Infinity')),
  sort       integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'pack') = (to_base IS NULL))
);
CREATE UNIQUE INDEX unit_code_lower ON unit (lower(code));

INSERT INTO unit (code, kind, to_base, sort) VALUES
  ('Gram',   'mass',   1,    10),
  ('Kg',     'mass',   1000, 20),
  ('Ml',     'volume', 1,    30),
  ('L',      'volume', 1000, 40),
  ('Each',   'each',   1,    50),
  ('Slice',  'slice',  1,    60),
  ('Carton', 'pack',   NULL, 70),
  ('Box',    'pack',   NULL, 80),
  ('Bag',    'pack',   NULL, 90),
  ('Tray',   'pack',   NULL, 100),
  ('Pack',   'pack',   NULL, 110);

ALTER TABLE ingredient
  ADD COLUMN purchase_unit    text REFERENCES unit(code) ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD COLUMN purchase_factor  double precision,
  ADD COLUMN inventory_unit   text REFERENCES unit(code) ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD COLUMN inventory_factor double precision,
  ADD CONSTRAINT ingredient_units_pair CHECK (
    (purchase_unit IS NULL) = (purchase_factor IS NULL) AND (inventory_unit IS NULL) = (inventory_factor IS NULL)
  ),
  ADD CONSTRAINT ingredient_units_factor CHECK (
    (purchase_factor  IS NULL OR (purchase_factor  > 0 AND purchase_factor  < 'Infinity')) AND
    (inventory_factor IS NULL OR (inventory_factor > 0 AND inventory_factor < 'Infinity'))
  );

-- every existing item: purchase = inventory = its base unit, factor 1 (what the item meant until now)
ALTER TABLE ingredient DISABLE TRIGGER ingredient_updated_at;  -- the backfill is not an edit: keep updated_at
UPDATE ingredient SET purchase_unit = uom, purchase_factor = 1, inventory_unit = uom, inventory_factor = 1;
ALTER TABLE ingredient ENABLE TRIGGER ingredient_updated_at;
