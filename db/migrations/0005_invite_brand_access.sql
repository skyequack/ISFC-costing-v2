-- ISFC 0005 — brands promised to a pending invitation (D-78, D-79). Purely additive.
--
-- Clerk holds the invitation (email + role); this table holds the brands the GM chose for it. At first sign-in
-- `provision` copies the rows to user_brand_access and deletes them. email is stored lower-cased. RESTRICT on the brand
-- (like user_brand_access): deleting a brand with a pending invitation is refused with a friendly 409, never silently
-- stripping promised access. GM invitations store no rows (a GM sees every brand).
CREATE TABLE invite_brand_access (
  email     text NOT NULL CHECK (email = lower(email)),
  brand_id  text NOT NULL REFERENCES brand(id) ON DELETE RESTRICT,
  PRIMARY KEY (email, brand_id)
);
CREATE INDEX invite_brand_access_brand_idx ON invite_brand_access (brand_id);
