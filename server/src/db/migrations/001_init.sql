CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  harness_id  TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  title       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  exited_at   INTEGER,
  exit_code   INTEGER
);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at          INTEGER NOT NULL,
  status      TEXT NOT NULL,
  wait_kind   TEXT
);

CREATE INDEX events_session ON events(session_id, at);
CREATE INDEX sessions_created ON sessions(created_at DESC);
