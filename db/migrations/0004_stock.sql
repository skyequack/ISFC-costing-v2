-- ISFC 0004 — stock counts and receipts (D-69, D-73). Purely additive.
--
-- No brand_id: a shelf is physical and a site can be shared by several brands, so rows are scoped by the user's visible sites
-- (the union of brand.locations over the brands they can see) and by the ingredient codes in their scope. No stage column:
-- counts are whole-ingredient; the thawing/cutting/cooking split (D-70) lives on the theoretical side only.
-- Codes are plain references, like recipe_line.code (no foreign key); the service accepts catalog ingredient codes only.
-- No row = not counted; a row with qty 0 = counted empty. Quantities are in the ingredient's own (purchase) unit.
CREATE TABLE stock_count (
  site       text NOT NULL,
  count_date date NOT NULL,
  code       text NOT NULL,
  qty        double precision NOT NULL CHECK (qty >= 0 AND qty < 'Infinity'),
  updated_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site, count_date, code)               -- also serves the grid's one-site-one-day read
);
CREATE INDEX stock_count_code_idx ON stock_count (code, site, count_date DESC);   -- latest count on/before a date (slice 2d)

-- Several deliveries of one item on one day are separate rows. `ref` names where a row came from: '' = typed in the grid
-- (one row per site/day/item, replaced when edited), anything else = an uploaded file (slice 2c), so an upload never
-- overwrites hand entry and a repeated upload is recognised.
CREATE TABLE receipt (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  site         text NOT NULL,
  receipt_date date NOT NULL,
  code         text NOT NULL,
  qty          double precision NOT NULL CHECK (qty > 0 AND qty < 'Infinity'),
  ref          text NOT NULL DEFAULT '',
  updated_by   text NOT NULL DEFAULT '',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site, receipt_date, code, ref)
);
CREATE INDEX receipt_code_idx ON receipt (code, site, receipt_date);
