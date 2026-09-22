-- User-editable session metadata. `title` already exists and becomes editable;
-- `pinned` keeps a session at the top of the sidebar.
ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
