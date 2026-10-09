-- ISFC 0002 — staging for chunked backup restore (D-37). A restore is uploaded in <= 1.5 MB slices (Vercel's request
-- body limit is 4.5 MB), kept here until the General Manager confirms, applied in ONE transaction, then deleted.
-- Rows older than a day are pruned whenever a new restore session starts.
CREATE TABLE restore_chunk (
  session_id text        NOT NULL,
  seq        integer     NOT NULL CHECK (seq >= 0),
  data       text        NOT NULL,
  user_id    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX restore_chunk_created_idx ON restore_chunk (created_at);
