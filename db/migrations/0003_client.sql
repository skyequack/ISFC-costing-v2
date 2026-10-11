-- ISFC 0003 — clients (D-68, D-71). A brand has many clients; a production row may name the client it was produced for.
--
-- production_entry.client_id: '' = unassigned (every existing row), the same convention as location ''. It is part of the
-- primary key so two clients can have separate rows for the same dish, day and site. There is no foreign key ('' is not a
-- client row); the service checks on every write that the client is active and belongs to the recipe's brand, and Data
-- Health reports orphans. Rollback is only possible while every production row still has client_id = ''.
CREATE TABLE client (
  id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  brand_id   text NOT NULL REFERENCES brand(id) ON DELETE RESTRICT,
  name       text NOT NULL CHECK (btrim(name) <> ''),
  active     boolean NOT NULL DEFAULT true,
  version    integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX client_brand_name_idx ON client (brand_id, lower(name));
CREATE TRIGGER client_updated_at BEFORE UPDATE ON client FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE production_entry ADD COLUMN client_id text NOT NULL DEFAULT '';
ALTER TABLE production_entry DROP CONSTRAINT production_entry_pkey;
ALTER TABLE production_entry ADD PRIMARY KEY (month, day, location, client_id, recipe_code);
