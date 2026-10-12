-- ISFC 0008 — per-user rate limiting counters (D-87, D-88). Purely additive and disposable.
--
-- One row per (Clerk user id, route class, fixed window). `window_start` is the window's first second as a Unix epoch
-- (computed from the DATABASE clock, so app instances cannot disagree about time). `n` counts the requests in that window.
-- No foreign key: the rows are throw-away counters, keyed by the Clerk user id so the check needs no user lookup.
-- Not part of backup/restore or Data Health. Rows older than two hours are deleted opportunistically by the limiter.
CREATE TABLE rate_limit (
  user_id      text    NOT NULL,
  cls          text    NOT NULL,
  window_start bigint  NOT NULL,
  n            integer NOT NULL,
  PRIMARY KEY (user_id, cls, window_start)
);

-- the cleanup deletes by age; the primary key cannot serve a range scan on window_start
CREATE INDEX rate_limit_window_idx ON rate_limit (window_start);
