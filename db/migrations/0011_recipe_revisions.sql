-- ISFC 0011 — card revisions (D-100, slice B1). Purely additive.
--
-- `recipe` keeps ONE live row per code: always the revision in force today. A revision starts the day it is saved (business day
-- Asia/Riyadh, no backdating, no future dates). Superseded revisions are archived in `recipe_version` (header, lock state incl.
-- cost_at_lock, method) and `recipe_version_line` (relational, so the rename cascade of D-33 can keep their codes right). Dates are
-- calendar days, half-open [effective_from, effective_to); only the start is stored on the live row, the end of an archived
-- revision is the start of the next one. The photo is not versioned.
--
-- Existing cards become revision 1, effective from the day they were created. Nothing reads these tables yet in this slice's
-- costing (that is B3), so every existing figure is unchanged.
ALTER TABLE recipe
  ADD COLUMN revision integer NOT NULL DEFAULT 1,
  ADD COLUMN effective_from date NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Riyadh')::date);
UPDATE recipe SET effective_from = (created_at AT TIME ZONE 'Asia/Riyadh')::date;
ALTER TABLE recipe ADD CONSTRAINT recipe_revision_check CHECK (revision >= 1);

CREATE TABLE recipe_version (
  id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  recipe_id         text NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  revision          integer NOT NULL,
  effective_from    date NOT NULL,
  effective_to      date NOT NULL,
  name              text NOT NULL,
  category          text NOT NULL,
  stock_class       text,
  type              recipe_type NOT NULL,
  brand_id          text NOT NULL,            -- informational (no FK): the card may move brand later
  output            double precision NOT NULL,
  sub_qty           double precision NOT NULL,
  sub_uom           text NOT NULL,
  batch_out         double precision NOT NULL,
  batch_uom         text NOT NULL,
  selling_price     double precision NOT NULL,
  buffer            double precision,
  status            recipe_status NOT NULL,
  locked_by         text,
  locked_at         timestamptz,
  locked_by_user_id text,
  cost_at_lock      jsonb,
  method            text[] NOT NULL DEFAULT '{}',
  origin            text NOT NULL,            -- BUTTON | UPLOAD | UNLOCK: what ended this revision
  created_by        text NOT NULL,
  created_by_user_id text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipe_id, revision),
  UNIQUE (recipe_id, effective_from),
  CHECK (effective_from < effective_to),
  CHECK (origin IN ('BUTTON', 'UPLOAD', 'UNLOCK'))
);
CREATE INDEX recipe_version_range_idx ON recipe_version (recipe_id, effective_to);

CREATE TABLE recipe_version_line (
  id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  version_id text NOT NULL REFERENCES recipe_version(id) ON DELETE CASCADE,
  sort_order integer NOT NULL,
  code       text NOT NULL,                     -- '' allowed (blank row); references by CODE, no FK (as recipe_line)
  qty        double precision NOT NULL,
  unit       text NOT NULL,
  y          double precision NOT NULL DEFAULT 1,
  yp         double precision,
  y_thaw     double precision,
  y_cut      double precision,
  y_cook     double precision,
  UNIQUE (version_id, sort_order),
  CHECK (qty >= 0 AND qty < 'Infinity' AND y > 0),
  CHECK (
    (y_thaw IS NULL OR (y_thaw > 0 AND y_thaw <= 10)) AND
    (y_cut  IS NULL OR (y_cut  > 0 AND y_cut  <= 10)) AND
    (y_cook IS NULL OR (y_cook > 0 AND y_cook <= 10))
  )
);
CREATE INDEX recipe_version_line_code_idx ON recipe_version_line (code);
