-- Small key/value store for server-side preferences (JSON values), plus a
-- per-session mute. Notification rules live here so phone and laptop agree.
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

ALTER TABLE sessions ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
