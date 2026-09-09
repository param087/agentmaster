-- Per-harness enable/disable, kept out of harnesses.yaml on purpose.
--
-- That file is hand-annotated with VERIFIED / UNVERIFIED notes and detection
-- rationale, and rewriting it programmatically would destroy the comments while
-- racing the config file watcher. YAML owns harness *definitions*; this table
-- owns *preferences*.
--
-- A harness with no row here is enabled iff its command is on PATH, so
-- installing a new CLI makes it appear in the picker without any interaction.
-- Only an explicit toggle is ever persisted.
CREATE TABLE harness_prefs (
  harness_id TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
