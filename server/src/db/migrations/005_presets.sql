-- Named launch presets: harness + folder + optional first prompt.
CREATE TABLE presets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  harness_id  TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  prompt      TEXT,
  created_at  INTEGER NOT NULL
);
