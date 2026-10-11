-- ISFC 0006 — index for the "was this receipts file already loaded" lookup and the upload undo (D-73, slice 2c).
-- receipt is read by code/site/date everywhere else; the file ref ('file:<hash>') had no index, so each check scanned the table.
CREATE INDEX receipt_ref_idx ON receipt (ref);
