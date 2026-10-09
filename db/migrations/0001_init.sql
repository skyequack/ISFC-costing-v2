-- ISFC 0001_init — hand-written PostgreSQL (Neon, PG 18). Source of truth for the schema; schema.md explains it.
-- Naming: snake_case tables/columns; `app_user` because `user` is reserved. TS maps rows to camelCase (src/lib/db/rows.ts).
-- Numerics are double precision on purpose (parity with JS doubles). Timestamps are timestamptz (UTC). IDs are text uuids.

CREATE TYPE recipe_type    AS ENUM ('MENU', 'SUB');
CREATE TYPE recipe_status  AS ENUM ('DRAFT', 'LOCKED');
CREATE TYPE history_action AS ENUM ('LOCK', 'UNLOCK');
CREATE TYPE menu_cell_kind AS ENUM ('ITEM', 'RECIPE', 'NONE');

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

CREATE TABLE brand (
  id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  legacy_id  text NOT NULL UNIQUE,            -- bnc, b1..b12, bssem
  code       text NOT NULL UNIQUE,            -- NC, GRM ... SSEM (recipe-code prefix)
  name       text NOT NULL UNIQUE,
  name_ar    text,
  color      text NOT NULL DEFAULT '',
  ink_color  text,
  locations  text[] NOT NULL DEFAULT '{}',
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE app_user (                        -- lazily provisioned on first authenticated request; role lives in Clerk
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  clerk_user_id   text NOT NULL UNIQUE,
  email           text,
  name            text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  last_role_seen  text,                        -- diagnostics only, never used for authorization
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_brand_access (
  id        text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id   text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  brand_id  text NOT NULL REFERENCES brand(id) ON DELETE RESTRICT,
  UNIQUE (user_id, brand_id)
);
CREATE INDEX user_brand_access_brand_idx ON user_brand_access (brand_id);

CREATE TABLE ingredient (                      -- code verbatim, case-sensitive unique; price NULL = PRICE MISSING (never 0)
  id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  code             text NOT NULL UNIQUE,
  name             text NOT NULL,
  uom              text NOT NULL CHECK (uom IN ('Gram','Ml','Each','Slice')),
  price            double precision CHECK (price IS NULL OR (price >= 0 AND price < 'Infinity')),
  price_updated_at timestamptz,
  category         text NOT NULL,
  subcategory      text NOT NULL,
  flag             text NOT NULL DEFAULT '',
  version          integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER ingredient_updated_at BEFORE UPDATE ON ingredient FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE item_brand_scope (                -- visibility scope (no rows = Shared), NOT a price override
  ingredient_id text NOT NULL REFERENCES ingredient(id) ON DELETE CASCADE,
  brand_id      text NOT NULL REFERENCES brand(id) ON DELETE RESTRICT,
  PRIMARY KEY (ingredient_id, brand_id)
);

CREATE TABLE unit_conversion (                 -- legacy S.conv[code] = [recipeUnit, factor]; line cost = qty / factor
  ingredient_id text PRIMARY KEY REFERENCES ingredient(id) ON DELETE CASCADE,
  recipe_unit   text NOT NULL,
  factor        double precision NOT NULL CHECK (factor > 0)
);

CREATE TABLE ingredient_price_history (        -- append-only (D-26)
  id                 text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  ingredient_id      text NOT NULL REFERENCES ingredient(id) ON DELETE CASCADE,
  old_price          double precision,
  new_price          double precision,
  source             text NOT NULL,            -- MANUAL | IMPORT | MENU_PLAN | SEED
  user_id            text,
  user_name_snapshot text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingredient_price_history_idx ON ingredient_price_history (ingredient_id, created_at);

CREATE TABLE recipe (
  id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  code              text NOT NULL,             -- uniqueness: partial unique index on lower(code) below
  name              text NOT NULL,
  category          text NOT NULL,
  type              recipe_type NOT NULL,
  brand_id          text NOT NULL REFERENCES brand(id) ON DELETE RESTRICT,   -- required (D-27)
  output            double precision NOT NULL DEFAULT 1,
  sub_qty           double precision NOT NULL DEFAULT 0,
  sub_uom           text NOT NULL DEFAULT 'Gram',
  batch_out         double precision NOT NULL DEFAULT 0,
  batch_uom         text NOT NULL DEFAULT 'Gram',
  selling_price     double precision NOT NULL DEFAULT 0,      -- legacy `price`, ex-VAT
  buffer            double precision,
  status            recipe_status NOT NULL DEFAULT 'DRAFT',
  locked_by         text,                       -- "Approved by" free text
  locked_at         timestamptz,
  locked_by_user_id text,
  cost_at_lock      jsonb,                      -- D-26 snapshot {food,totalCost,sellingPrice,fcPct,settings,priceDate,overrideReason?}
  version           integer NOT NULL DEFAULT 0,
  deleted_at        timestamptz,
  deleted_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX recipe_code_lower_live ON recipe (lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX recipe_brand_deleted_idx ON recipe (brand_id, deleted_at);
CREATE TRIGGER recipe_updated_at BEFORE UPDATE ON recipe FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE recipe_photo (                    -- D-48/D-49: bytes in their own table so list queries cannot pull blobs
  recipe_id    text PRIMARY KEY REFERENCES recipe(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  data         bytea NOT NULL,
  size         integer NOT NULL,
  width        integer NOT NULL,
  height       integer NOT NULL,
  sha256       text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (size > 0 AND size <= 1500000 AND width BETWEEN 1 AND 4096 AND height BETWEEN 1 AND 4096)
);
CREATE TRIGGER recipe_photo_updated_at BEFORE UPDATE ON recipe_photo FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE brand_logo (
  brand_id     text PRIMARY KEY REFERENCES brand(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  data         bytea NOT NULL,
  size         integer NOT NULL,
  width        integer NOT NULL,
  height       integer NOT NULL,
  sha256       text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (size > 0 AND size <= 512000 AND width BETWEEN 1 AND 1024 AND height BETWEEN 1 AND 1024)
);
CREATE TRIGGER brand_logo_updated_at BEFORE UPDATE ON brand_logo FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE recipe_line (                     -- references by CODE (no FK): 'CODE NOT FOUND' is a legal legacy state
  id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  recipe_id  text NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  sort_order integer NOT NULL,
  code       text NOT NULL,                     -- '' allowed (blank row)
  qty        double precision NOT NULL,
  unit       text NOT NULL,
  y          double precision NOT NULL DEFAULT 1,
  yp         double precision,                  -- NULL is not 0 (null falls back to card buffer)
  UNIQUE (recipe_id, sort_order),
  CHECK (qty >= 0 AND qty < 'Infinity' AND y > 0)
);
CREATE INDEX recipe_line_code_idx ON recipe_line (code);

CREATE TABLE recipe_method_step (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  recipe_id   text NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  step_number integer NOT NULL,
  text        text NOT NULL,
  UNIQUE (recipe_id, step_number)
);

CREATE TABLE recipe_history_entry (
  id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  recipe_id  text NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  action     history_action NOT NULL,
  who        text NOT NULL,
  user_id    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recipe_history_entry_idx ON recipe_history_entry (recipe_id, created_at);

CREATE TABLE cost_settings (                   -- singleton (id = 1), not brand scoped; legacy names, fractions
  id         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  currency   text NOT NULL DEFAULT 'SAR',
  pkg        double precision NOT NULL DEFAULT 0.10,
  del        double precision NOT NULL DEFAULT 0.10,
  lab        double precision NOT NULL DEFAULT 0.25,
  ops        double precision NOT NULL DEFAULT 0.05,
  buffer     double precision NOT NULL DEFAULT 0.15,
  target     double precision NOT NULL DEFAULT 0.30,
  vat        double precision NOT NULL DEFAULT 0.15,
  price_date date NOT NULL,
  version    integer NOT NULL DEFAULT 0
);

CREATE TABLE audit_log (                       -- append-only, enforced by triggers below
  id                 text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  user_id            text,
  user_name_snapshot text NOT NULL,
  role_snapshot      text NOT NULL,
  action             text NOT NULL,
  detail             text NOT NULL DEFAULT ''
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at);
CREATE INDEX audit_log_user_idx    ON audit_log (user_id);
CREATE INDEX audit_log_action_idx  ON audit_log (action, created_at);
CREATE FUNCTION audit_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_no_mutate   BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW       EXECUTE FUNCTION audit_immutable();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE         ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();

-- Editable menus (D-05), seeded from legacy MENU_PLAN
CREATE TABLE menu (
  id           text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  legacy_index integer UNIQUE,                  -- translates legacy 'LOC|menuIndex' pax keys on restore
  name         text NOT NULL UNIQUE,
  sort_order   integer NOT NULL,
  days         text[] NOT NULL DEFAULT '{}',
  active       boolean NOT NULL DEFAULT true,
  version      integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER menu_updated_at BEFORE UPDATE ON menu FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE menu_row (                        -- meal label is NOT unique (BREAKFAST x8)
  id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  menu_id    text NOT NULL REFERENCES menu(id) ON DELETE CASCADE,
  sort_order integer NOT NULL,
  meal       text NOT NULL,
  UNIQUE (menu_id, sort_order)
);

CREATE TABLE menu_cell (                       -- ITEM -> ingredient.code, RECIPE -> recipe.code, NONE has no code
  id     text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  row_id text NOT NULL REFERENCES menu_row(id) ON DELETE CASCADE,
  day    text NOT NULL,
  kind   menu_cell_kind NOT NULL,
  code   text,
  label  text NOT NULL,
  UNIQUE (row_id, day),
  CHECK ((kind = 'NONE') = (code IS NULL))
);
CREATE INDEX menu_cell_code_idx ON menu_cell (code);

CREATE TABLE menu_pax (
  month    text NOT NULL,                        -- 'YYYY-MM'
  day      text NOT NULL,                        -- '01'..'31'
  location text NOT NULL DEFAULT '',
  menu_id  text NOT NULL REFERENCES menu(id) ON DELETE CASCADE,
  people   integer NOT NULL CHECK (people >= 0),
  PRIMARY KEY (month, day, location, menu_id)
);

CREATE TABLE production_entry (                -- location '' = legacy/unassigned bucket
  month       text NOT NULL,
  day         text NOT NULL,
  location    text NOT NULL DEFAULT '',
  recipe_code text NOT NULL,
  portions    integer NOT NULL CHECK (portions >= 0),
  PRIMARY KEY (month, day, location, recipe_code)
);
CREATE INDEX production_entry_recipe_idx ON production_entry (recipe_code);

CREATE TABLE seed_run (
  id       text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  version  text NOT NULL,
  checksum text NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);
